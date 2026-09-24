// streamGoogleCca: request dispatch, endpoint failover and finalization.
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { buildCcaRequest, antigravitySession } from "./cca-request.ts";
import { createCcaConsumer } from "./cca-consumer.ts";
import {
	ANTIGRAVITY_ENDPOINTS,
	GEMINI_CLI_ENDPOINT,
	RETRY_BASE_DELAY_MS,
	geminiCliUserAgent,
} from "./endpoints.ts";
import { isClaudeModel } from "./model-catalog.ts";
import { antigravityUserAgent, ensureAntigravityVersion } from "./oauth.ts";
import { invalidateQuotaCache } from "./quota.ts";
import {
	doFetchWithRetry,
	isRetriableStatus,
	isRetriableTransportError,
	parseStoredCredential,
	sleep,
} from "./retry.ts";

export function streamGoogleCca(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const credential = parseStoredCredential(options?.apiKey);
			const isAntigravity = credential.variant === "antigravity";
			await ensureAntigravityVersion(options?.signal);

			let endpoints = isAntigravity
				? (antigravitySession.lastGoodEndpoint
						? [antigravitySession.lastGoodEndpoint, ...ANTIGRAVITY_ENDPOINTS.filter((e) => e !== antigravitySession.lastGoodEndpoint)]
						: ANTIGRAVITY_ENDPOINTS)
				: [GEMINI_CLI_ENDPOINT];

			let requestPayload: unknown = buildCcaRequest(
				model,
				context,
				credential.projectId,
				options,
				isAntigravity,
			);

			if (options?.onPayload) {
				const replacement = await options.onPayload(requestPayload, model);
				if (replacement !== undefined) {
					requestPayload = replacement;
				}
			}

			const body = JSON.stringify(requestPayload);
			const isClaude = isClaudeModel(model.id);

			const headers: Record<string, string> = {
				Authorization: `Bearer ${credential.token}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...(isAntigravity
					? { "User-Agent": antigravityUserAgent() }
					: {
							"User-Agent": geminiCliUserAgent(model.id),
							"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
						}),
				...(isAntigravity && isClaude && options?.reasoning
					? { "anthropic-beta": "interleaved-thinking-2025-05-14" }
					: {}),
				...(options?.headers ?? {}),
			};

			const toolNames = new Set(context.tools?.map((t) => t.name) ?? []);
			const isLeakModel = model.id.includes("flash");
			let started = false;
			let firstTokenTime: number | undefined;

			const ensureStarted = () => {
				if (!started) {
					if (!firstTokenTime) firstTokenTime = performance.now();
					stream.push({ type: "start", partial: output });
					started = true;
				}
			};

			const resetOutput = () => {
				output.content = [];
				output.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				output.stopReason = "pending";
				output.errorMessage = undefined;
			};
			// Response consumption lives in its own module (see cca-consumer.ts).
			const { consumeResponse } = createCcaConsumer({
				model,
				stream,
				output,
				toolNames,
				isLeakModel,
				isAntigravity,
				ensureStarted,
			});


			// Endpoint failover (antigravity: primary → sandbox)
			const MAX_EMPTY_RETRIES = 2;
			let succeeded = false;

			for (let endpointIndex = 0; endpointIndex < endpoints.length && !succeeded; endpointIndex++) {
				const endpoint = endpoints[endpointIndex]!;
				const isLastEndpoint = endpointIndex === endpoints.length - 1;

				for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt++) {
					if (options?.signal?.aborted) throw new Error("Request was aborted");

					let response: Response;
					try {
						response = await doFetchWithRetry(
							`${endpoint}/v1internal:streamGenerateContent?alt=sse`,
							{ method: "POST", headers, body },
							options,
						);
					} catch (err) {
						if (options?.signal?.aborted) throw new Error("Request was aborted");
						if (!isLastEndpoint && isRetriableTransportError(err)) break; // try fallback endpoint
						throw err;
					}

					if (options?.onResponse) {
						const responseHeaders: Record<string, string> = {};
						response.headers.forEach((val, key) => {
							responseHeaders[key] = val;
						});
						await options.onResponse({ status: response.status, headers: responseHeaders }, model);
					}

					if (!response.ok) {
						const errorText = await response.text().catch(() => "");
						if (response.status === 429) {
							invalidateQuotaCache();
						}
						if (isRetriableStatus(response.status) && attempt < MAX_EMPTY_RETRIES) {
							await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, options?.signal);
							resetOutput();
							continue;
						}
						if (!isLastEndpoint && (isRetriableStatus(response.status) || response.status === 404)) break; // try fallback endpoint
						if (response.status === 429) {
							throw new Error(
								`Cloud Code Assist rate limit exceeded (HTTP 429). Check /google-quota for reset times. Upstream: ${errorText}`,
							);
						}
						throw new Error(`Cloud Code Assist API error (${response.status}): ${errorText}`);
					}

					let meaningful = false;
					try {
						meaningful = await consumeResponse(response);
					} catch (err) {
						if (options?.signal?.aborted) throw new Error("Request was aborted");
						if (isRetriableTransportError(err) && attempt < MAX_EMPTY_RETRIES) {
							await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, options?.signal);
							resetOutput();
							continue;
						}
						throw err;
					}

					if (
						output.stopReason === "error" &&
						output.errorMessage?.includes("MALFORMED_FUNCTION_CALL") &&
						attempt < MAX_EMPTY_RETRIES
					) {
						await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, options?.signal);
						resetOutput();
						continue;
					}

					if ((output.stopReason !== "pending" && output.stopReason !== "error") || meaningful) {
						if (isAntigravity) antigravitySession.lastGoodEndpoint = endpoint;
						succeeded = true;
						break;
					}

					if (attempt >= MAX_EMPTY_RETRIES) break;
					resetOutput();
				}
			}

			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") {
				throw new Error(
					"Cloud Code Assist stream ended without a finish reason (connection dropped or empty response)",
				);
			}

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output,
				});
			} else {
				stream.push({
					type: "done",
					reason: output.stopReason,
					message: output,
				});
			}
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}
