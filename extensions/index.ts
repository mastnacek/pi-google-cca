/**
 * Pi extension: browser OAuth login for the built-in `google` provider,
 * exactly like the omp CLI's Google login.
 *
 * What it does:
 *   - `pi.registerProvider("google", { oauth, streamSimple })` overrides the
 *     built-in google provider: NO model lists are added — pi's own google
 *     catalog (gemini-2.5-flash, gemini-3.7-flash, …) is kept as-is.
 *   - `/login google` runs the omp-style browser flow (loopback callback
 *     server, CSRF state, offline access) with a client picker:
 *       Antigravity (daily-cloudcode-pa, newest Gemini) or Gemini CLI
 *       (cloudcode-pa). Both are the public Cloud Code Assist clients omp
 *       embeds (ported from packages/ai/src/registry/oauth/ in oh-my-pi).
 *   - Requests are streamed through the Cloud Code Assist wire protocol
 *     (POST {endpoint}/v1internal:streamGenerateContent?alt=sse with the
 *     `{project, model, request}` envelope) instead of the Generative
 *     Language API, authenticating with the OAuth access token.
 *   - Tokens refresh automatically near expiry via the `oauth.refreshToken`
 *     hook; the grant's client variant and Cloud project id persist alongside
 *     the token in ~/.pi/agent/auth.json.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
import {
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	mapStopReasonString,
	retainThoughtSignature,
	type GeminiContent,
	type GeminiPart,
	type GoogleThinkingLevel,
	type ModelWire,
} from "./google-wire.ts";
import {
	antigravityUserAgent,
	deriveAntigravitySessionId,
	googleCredentialApiKey,
	loginGoogle,
	refreshGoogleToken,
} from "./oauth.ts";

const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const REQUEST_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

/** Gemini-CLI-style User-Agent: unlocks the CLI rate-limit tier. */
function geminiCliUserAgent(modelId: string): string {
	const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.46.0";
	const platform = process.platform === "win32" ? "win32" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

// ---------------------------------------------------------------------------
// Antigravity wire details (omp catalog): effort-routed model ids, fixed
// output caps, labels.model_enum telemetry tokens. Sending the catalog's
// logical id where a routed wire id is required yields 404 NOT_FOUND.
// ---------------------------------------------------------------------------

const ANTIGRAVITY_WIRE_PROFILES: Record<
	string,
	{ modelEnum?: string; maxOutputTokens: number }
> = {
	"gemini-3.5-flash-extra-low": {
		modelEnum: "MODEL_PLACEHOLDER_M187",
		maxOutputTokens: 65_536,
	},
	"gemini-3.5-flash-low": {
		modelEnum: "MODEL_PLACEHOLDER_M20",
		maxOutputTokens: 65_536,
	},
	"gemini-3-flash-agent": {
		modelEnum: "MODEL_PLACEHOLDER_M132",
		maxOutputTokens: 65_536,
	},
	"gemini-3.6-flash-low": {
		modelEnum: "MODEL_PLACEHOLDER_M73",
		maxOutputTokens: 65_536,
	},
	"gemini-3.6-flash-medium": {
		modelEnum: "MODEL_PLACEHOLDER_M72",
		maxOutputTokens: 65_536,
	},
	"gemini-3.6-flash-high": {
		modelEnum: "MODEL_PLACEHOLDER_M71",
		maxOutputTokens: 65_536,
	},
	"gemini-3.7-flash-low": {
		modelEnum: "MODEL_PLACEHOLDER_M300",
		maxOutputTokens: 65_536,
	},
	"gemini-3.7-flash-medium": {
		modelEnum: "MODEL_PLACEHOLDER_M299",
		maxOutputTokens: 65_536,
	},
	"gemini-3.7-flash-high": {
		modelEnum: "MODEL_PLACEHOLDER_M298",
		maxOutputTokens: 65_536,
	},
	"gemini-3.8-flash-low": {
		modelEnum: "MODEL_PLACEHOLDER_M320",
		maxOutputTokens: 65_536,
	},
	"gemini-3.8-flash-medium": {
		modelEnum: "MODEL_PLACEHOLDER_M319",
		maxOutputTokens: 65_536,
	},
	"gemini-3.8-flash-high": {
		modelEnum: "MODEL_PLACEHOLDER_M318",
		maxOutputTokens: 65_536,
	},
	"gemini-3.1-pro-low": {
		modelEnum: "MODEL_PLACEHOLDER_M36",
		maxOutputTokens: 65_535,
	},
	"gemini-pro-agent": {
		modelEnum: "MODEL_PLACEHOLDER_M16",
		maxOutputTokens: 65_535,
	},
};

/** pi google catalog id → antigravity upstream wire id per thinking effort. */
const ANTIGRAVITY_MODEL_ROUTING: Record<string, Record<string, string>> = {
	"gemini-3-flash-preview": {
		off: "gemini-3.5-flash-extra-low",
		minimal: "gemini-3.5-flash-extra-low",
		low: "gemini-3.5-flash-extra-low",
		medium: "gemini-3.5-flash-low",
		high: "gemini-3-flash-agent",
	},
	"gemini-3.5-flash": {
		off: "gemini-3.5-flash-extra-low",
		minimal: "gemini-3.5-flash-extra-low",
		low: "gemini-3.5-flash-extra-low",
		medium: "gemini-3.5-flash-low",
		high: "gemini-3-flash-agent",
	},
	"gemini-3.5-flash-lite": {
		off: "gemini-3.5-flash-extra-low",
		minimal: "gemini-3.5-flash-extra-low",
		low: "gemini-3.5-flash-extra-low",
		medium: "gemini-3.5-flash-low",
		high: "gemini-3-flash-agent",
	},
	"gemini-3.6-flash": {
		off: "gemini-3.6-flash-low",
		minimal: "gemini-3.6-flash-low",
		low: "gemini-3.6-flash-low",
		medium: "gemini-3.6-flash-medium",
		high: "gemini-3.6-flash-high",
	},
	"gemini-3.7-flash": {
		off: "gemini-3.7-flash-low",
		minimal: "gemini-3.7-flash-low",
		low: "gemini-3.7-flash-low",
		medium: "gemini-3.7-flash-medium",
		high: "gemini-3.7-flash-high",
	},
	"gemini-3.8-flash": {
		off: "gemini-3.8-flash-low",
		minimal: "gemini-3.8-flash-low",
		low: "gemini-3.8-flash-low",
		medium: "gemini-3.8-flash-medium",
		high: "gemini-3.8-flash-high",
	},
	"gemini-flash-latest": {
		off: "gemini-3.5-flash-extra-low",
		minimal: "gemini-3.5-flash-extra-low",
		low: "gemini-3.5-flash-extra-low",
		medium: "gemini-3.5-flash-low",
		high: "gemini-3-flash-agent",
	},
	"gemini-flash-lite-latest": {
		off: "gemini-3.5-flash-extra-low",
		minimal: "gemini-3.5-flash-extra-low",
		low: "gemini-3.5-flash-extra-low",
		medium: "gemini-3.5-flash-low",
		high: "gemini-3-flash-agent",
	},
	"gemini-3.1-pro-preview": {
		off: "gemini-3.1-pro-low",
		minimal: "gemini-3.1-pro-low",
		low: "gemini-3.1-pro-low",
		medium: "gemini-3.1-pro-low",
		high: "gemini-pro-agent",
	},
	"gemini-3.1-pro-preview-customtools": {
		off: "gemini-3.1-pro-low",
		minimal: "gemini-3.1-pro-low",
		low: "gemini-3.1-pro-low",
		medium: "gemini-3.1-pro-low",
		high: "gemini-pro-agent",
	},
};

function antigravityWireModelId(
	modelId: string,
	effort: string | undefined,
): string {
	const routing = ANTIGRAVITY_MODEL_ROUTING[modelId];
	if (!routing) return modelId;
	return routing[effort ?? "off"] ?? Object.values(routing)[0]!;
}

// ---------------------------------------------------------------------------
// Thinking config (same policy as pi-ai's google adapter)
// ---------------------------------------------------------------------------

interface ThinkingConfig {
	includeThoughts: boolean;
	thinkingLevel?: GoogleThinkingLevel;
	thinkingBudget?: number;
}

function isGemini3Pro(id: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(id.toLowerCase());
}
function isGemini3Flash(id: string): boolean {
	const lower = id.toLowerCase();
	return (
		/gemini-3(?:\.\d+)?-flash/.test(lower) ||
		lower === "gemini-flash-latest" ||
		lower === "gemini-flash-lite-latest"
	);
}

function thinkingConfigFor(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): ThinkingConfig | undefined {
	if (!model.reasoning) return undefined;

	if (!options?.reasoning) {
		// Explicit off. Gemini 3 models cannot fully disable thinking; hide it.
		if (isGemini3Pro(model.id))
			return { includeThoughts: false, thinkingLevel: "LOW" };
		if (isGemini3Flash(model.id))
			return { includeThoughts: false, thinkingLevel: "MINIMAL" };
		return { includeThoughts: false, thinkingBudget: 0 };
	}

	const effort: ThinkingLevel = options.reasoning;
	if (isGemini3Pro(model.id)) {
		return {
			includeThoughts: true,
			thinkingLevel: effort === "minimal" || effort === "low" ? "LOW" : "HIGH",
		};
	}
	if (isGemini3Flash(model.id)) {
		let level: GoogleThinkingLevel = "HIGH";
		if (effort === "minimal") level = "MINIMAL";
		else if (effort === "low") level = "LOW";
		else if (effort === "medium") level = "MEDIUM";
		return { includeThoughts: true, thinkingLevel: level };
	}
	// Token budgets for the 2.5 family.
	const budgets: Record<string, Partial<Record<ThinkingLevel, number>>> = {
		"gemini-2.5-pro": { minimal: 128, low: 2048, medium: 8192, high: 32_768 },
		"gemini-2.5-flash-lite": {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24_576,
		},
		"gemini-2.5-flash": { minimal: 128, low: 2048, medium: 8192, high: 24_576 },
	};
	const budget = (budgets[model.id] ?? {})[effort];
	return { includeThoughts: true, thinkingBudget: budget ?? -1 };
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

interface CcaRequest {
	project: string;
	model: string;
	request: {
		contents: GeminiContent[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			temperature?: number;
			maxOutputTokens?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: { functionDeclarations: unknown[] }[];
		toolConfig?: { functionCallingConfig: { mode: string } };
		labels?: Record<string, string>;
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

/** Per-conversation Antigravity envelope state (one conversation per pi process). */
const antigravitySession = {
	agentId: undefined as string | undefined,
	trajectoryId: undefined as string | undefined,
	sessionId: undefined as string | undefined,
	stepIndex: undefined as number | undefined,
	lastExecutionId: undefined as string | undefined,
};

function firstUserText(context: Context): string | undefined {
	for (const message of context.messages) {
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			const firstText = message.content.find((item) => item.type === "text");
			return firstText && "text" in firstText ? firstText.text : undefined;
		}
		return undefined;
	}
	return undefined;
}

function buildCcaRequest(
	model: Model<Api>,
	context: Context,
	projectId: string,
	options: SimpleStreamOptions | undefined,
	isAntigravity: boolean,
): CcaRequest {
	const wireModel: ModelWire = {
		id: model.id,
		provider: model.provider,
		api: model.api,
		input: model.input,
	};
	const contents = convertMessages(wireModel, context);
	const generationConfig: CcaRequest["request"]["generationConfig"] = {};
	if (options?.temperature !== undefined)
		generationConfig.temperature = options.temperature;
	if (options?.maxTokens !== undefined)
		generationConfig.maxOutputTokens = options.maxTokens;

	const thinking = thinkingConfigFor(model, options);
	if (thinking) generationConfig.thinkingConfig = thinking;

	const request: CcaRequest["request"] = { contents };
	if (context.systemPrompt && context.systemPrompt.trim().length > 0) {
		// Antigravity tags systemInstruction with role "user" (mirrors the real client).
		request.systemInstruction = {
			...(isAntigravity ? { role: "user" } : {}),
			parts: [{ text: context.systemPrompt }],
		};
	}
	if (context.tools && context.tools.length > 0) {
		request.tools = convertTools(context.tools);
		// Antigravity's default tool mode is VALIDATED (verified for Gemini and
		// Claude in omp); without it the backend may answer in text.
		if (isAntigravity) {
			request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
		}
	}
	if (Object.keys(generationConfig).length > 0)
		request.generationConfig = generationConfig;

	if (!isAntigravity) return { project: projectId, model: model.id, request };

	// Antigravity envelope: effort-routed wire id, fixed output cap, sessionId,
	// structured requestId, labels.
	const wireModelId = antigravityWireModelId(model.id, options?.reasoning);
	const profile = ANTIGRAVITY_WIRE_PROFILES[wireModelId];
	if (profile) generationConfig.maxOutputTokens = profile.maxOutputTokens;

	const state = antigravitySession;
	state.agentId ??= randomUUID();
	state.trajectoryId ??= randomUUID();
	state.sessionId ??= deriveAntigravitySessionId(firstUserText(context));
	state.stepIndex = (state.stepIndex ?? 1) + 1;
	const requestId = `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${state.stepIndex}`;
	const labels: Record<string, string> = {};
	if (state.lastExecutionId) labels.last_execution_id = state.lastExecutionId;
	labels.last_step_index = String((state.stepIndex ?? 2) - 1);
	if (profile?.modelEnum !== undefined) labels.model_enum = profile.modelEnum;
	labels.trajectory_id = state.trajectoryId;

	request.labels = labels;
	request.sessionId = state.sessionId;
	return {
		project: projectId,
		requestId,
		request,
		model: wireModelId,
		userAgent: "antigravity",
		requestType: "agent",
	};
}

// ---------------------------------------------------------------------------
// Response streaming
// ---------------------------------------------------------------------------

interface CcaResponseChunk {
	response?: {
		candidates?: Array<{
			content?: { role: string; parts?: GeminiPart[] };
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		responseId?: string;
		promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
	};
	/** In-band stream failure (quota, internal error) as a final JSON event. */
	error?: { code?: number; message?: string; status?: string };
}

/** Minimal SSE reader: yields the JSON payload of each `data:` line. */
async function* readSseData(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline).replace(/\r$/, "");
				buffer = buffer.slice(newline + 1);
				if (line.startsWith("data: ")) yield line.slice(6);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

// --- Gemini Flash planning-leak guard (ported from omp google-gemini-cli) ---
// Some Flash models emit their internal planning object as visible text
// (`{"thought": ...}`). Buffer a leading `{` run and strip it when it matches
// the leak signature; release as normal text otherwise.

function isPlanningLeakPrefix(text: string): boolean {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{")) return false;
	const afterBrace = trimmed.slice(1).trimStart();
	if (afterBrace === "") return trimmed.length <= 100;
	if (afterBrace[0] !== '"') return false;
	const nextQuote = afterBrace.indexOf('"', 1);
	if (nextQuote === -1) {
		const keyPrefix = afterBrace.slice(1);
		return "thought".startsWith(keyPrefix) && trimmed.length <= 100;
	}
	const key = afterBrace.slice(1, nextQuote);
	if (key !== "thought") return false;
	const afterKey = afterBrace.slice(nextQuote + 1).trimStart();
	if (afterKey === "") return trimmed.length <= 100;
	return afterKey[0] === ":";
}

function splitLeadingJsonObject(
	text: string,
	ignoreQuotes: boolean,
): { jsonText: string; rest: string } | undefined {
	const prefixLength = text.length - text.trimStart().length;
	const trimmed = text.slice(prefixLength);
	if (!trimmed.startsWith("{")) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (!ignoreQuotes) {
			if (inString) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					continue;
				}
				if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
		}
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0)
				return { jsonText: trimmed.slice(0, i + 1), rest: trimmed.slice(i + 1) };
		}
	}
	return undefined;
}

function isPlanningLeakObject(
	parsed: unknown,
	toolNames: Set<string>,
): boolean {
	if (!parsed || typeof parsed !== "object") return false;
	const record = parsed as Record<string, unknown>;
	const hasThought = typeof record.thought === "string";
	const isOmpTool =
		typeof record.call === "string" && toolNames.has(record.call);
	const hasToolSignature =
		"_i" in record ||
		"paths" in record ||
		"command" in record ||
		("path" in record && "content" in record);
	return hasThought || isOmpTool || hasToolSignature;
}

type BufferedPlanning =
	| { kind: "incomplete" }
	| { kind: "plain"; visibleText: string }
	| { kind: "leak"; visibleText: string };

function consumePlanningBuffer(
	text: string,
	toolNames: Set<string>,
	isFinal = false,
): BufferedPlanning {
	if (!isPlanningLeakPrefix(text)) return { kind: "plain", visibleText: text };

	const leading =
		splitLeadingJsonObject(text, false) ?? splitLeadingJsonObject(text, true);

	if (!leading) {
		if (isFinal) {
			const trimmed = text.trim();
			const hasThoughtKey = trimmed.includes('"thought"');
			const hasToolKey = [...toolNames].some((name) =>
				trimmed.includes(`"${name}"`),
			);
			const hasToolSignature =
				trimmed.includes('"_i"') ||
				trimmed.includes('"paths"') ||
				trimmed.includes('"command"') ||
				(trimmed.includes('"path"') && trimmed.includes('"content"'));
			if (hasThoughtKey || hasToolKey || hasToolSignature)
				return { kind: "leak", visibleText: "" };
			return { kind: "plain", visibleText: text };
		}
		return { kind: "incomplete" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(leading.jsonText);
	} catch {
		const hasThoughtKey = leading.jsonText.includes('"thought"');
		const hasToolKey = [...toolNames].some((name) =>
			leading.jsonText.includes(`"${name}"`),
		);
		const isLeak = hasThoughtKey || hasToolKey;
		return isLeak
			? { kind: "leak", visibleText: leading.rest }
			: { kind: "plain", visibleText: text };
	}

	return isPlanningLeakObject(parsed, toolNames)
		? { kind: "leak", visibleText: leading.rest }
		: { kind: "plain", visibleText: text };
}

// ---------------------------------------------------------------------------

let toolCallCounter = 0;

interface ParsedCredential {
	token: string;
	projectId: string;
	variant: "antigravity" | "gemini-cli";
}

function parseStoredCredential(apiKey: string | undefined): ParsedCredential {
	if (!apiKey) {
		throw new Error(
			"google provider is set up for Google OAuth (Cloud Code Assist). Run /login google to authenticate.",
		);
	}
	// The oauth getApiKey hook serializes {token, projectId, variant}; anything
	// else (e.g. a leftover AI Studio key) cannot drive the CCA protocol.
	try {
		const parsed = JSON.parse(apiKey) as Partial<ParsedCredential>;
		if (parsed.token && parsed.projectId) {
			return {
				token: parsed.token,
				projectId: parsed.projectId,
				variant: parsed.variant === "gemini-cli" ? "gemini-cli" : "antigravity",
			};
		}
	} catch {
		/* not our JSON — fall through to the guidance error */
	}
	throw new Error(
		"google provider is set up for Google OAuth (Cloud Code Assist); an API key cannot drive it. Run /login google to authenticate in the browser.",
	);
}

function isRetriableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function isRetriableTransportError(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "TypeError" ||
			err.name === "TimeoutError" ||
			/HTTP \d{3}/.test(err.message) ||
			/fetch failed|network|ECONNRESET|socket|hang up/i.test(err.message))
	);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("Request was aborted"));
			},
			{ once: true },
		);
	});
}

async function doFetchWithRetry(
	url: string,
	init: RequestInit,
	options?: SimpleStreamOptions,
): Promise<Response> {
	const fetchImpl = options?.fetch ?? fetch;
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0)
			await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), options?.signal);
		try {
			const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const signal = options?.signal
				? AbortSignal.any([options.signal, timeoutSignal])
				: timeoutSignal;
			const response = await fetchImpl(url, { ...init, signal });
			if (
				!response.ok &&
				isRetriableStatus(response.status) &&
				attempt < MAX_RETRIES
			) {
				lastError = new Error(`HTTP ${response.status}`);
				continue;
			}
			return response;
		} catch (err) {
			lastError = err;
			if (options?.signal?.aborted) throw err;
			if (!isRetriableTransportError(err)) throw err;
		}
	}
	throw lastError;
}

function streamGoogleCca(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
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
			const endpoints = isAntigravity
				? ANTIGRAVITY_ENDPOINTS
				: [GEMINI_CLI_ENDPOINT];
			const body = JSON.stringify(
				buildCcaRequest(
					model,
					context,
					credential.projectId,
					options,
					isAntigravity,
				),
			);
			const headers = {
				Authorization: `Bearer ${credential.token}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...(isAntigravity
					? { "User-Agent": antigravityUserAgent() }
					: {
							"User-Agent": geminiCliUserAgent(model.id),
							"Client-Metadata":
								"ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
						}),
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

			/** Consume one SSE response into `output`. Returns true when content arrived. */
			const consumeResponse = async (response: Response): Promise<boolean> => {
				if (!response.body)
					throw new Error("Cloud Code Assist: empty response body");

				let currentBlock:
					| { type: "text"; text: string; textSignature?: string }
					| { type: "thinking"; thinking: string; thinkingSignature?: string }
					| null = null;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;

				let isBuffering = false;
				let textBuffer = "";
				let bufferedSignature: string | undefined;
				let sawContent = false;
				let lastResponseId: string | undefined;

				const endCurrentBlock = () => {
					if (!currentBlock) return;
					if (currentBlock.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: blockIndex(),
							content: currentBlock.text,
							partial: output,
						});
					} else {
						stream.push({
							type: "thinking_end",
							contentIndex: blockIndex(),
							content: currentBlock.thinking,
							partial: output,
						});
					}
					currentBlock = null;
				};
				const startTextBlock = () => {
					if (currentBlock?.type !== "text") {
						endCurrentBlock();
						currentBlock = { type: "text", text: "" };
						blocks.push(currentBlock);
						ensureStarted();
						stream.push({
							type: "text_start",
							contentIndex: blockIndex(),
							partial: output,
						});
					}
					return currentBlock;
				};
				const startThinkingBlock = () => {
					if (currentBlock?.type !== "thinking") {
						endCurrentBlock();
						currentBlock = {
							type: "thinking",
							thinking: "",
							thinkingSignature: undefined,
						};
						blocks.push(currentBlock);
						ensureStarted();
						stream.push({
							type: "thinking_start",
							contentIndex: blockIndex(),
							partial: output,
						});
					}
					return currentBlock;
				};
				const emitText = (delta: string, signature?: string) => {
					if (!delta) return;
					const block = startTextBlock();
					block.text += delta;
					block.textSignature = retainThoughtSignature(
						block.textSignature,
						signature,
					);
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta,
						partial: output,
					});
				};
				const flushLeakBuffer = () => {
					if (!isBuffering) return;
					const buffered = consumePlanningBuffer(textBuffer, toolNames, true);
					if (buffered.kind !== "incomplete")
						emitText(buffered.visibleText, bufferedSignature);
					isBuffering = false;
					textBuffer = "";
					bufferedSignature = undefined;
				};

				for await (const data of readSseData(response.body)) {
					let chunk: CcaResponseChunk;
					try {
						chunk = JSON.parse(data) as CcaResponseChunk;
					} catch {
						continue;
					}

					if (chunk.error) {
						const detail =
							chunk.error.message || chunk.error.status || "unknown error";
						throw new Error(`Cloud Code Assist stream error: ${detail}`);
					}
					const responseData = chunk.response;
					if (!responseData) continue;
					if (responseData.responseId) lastResponseId = responseData.responseId;

					if (
						!responseData.candidates?.length &&
						responseData.promptFeedback?.blockReason
					) {
						const detail = responseData.promptFeedback.blockReasonMessage;
						throw new Error(
							`Request blocked by Google (${responseData.promptFeedback.blockReason})${detail ? `: ${detail}` : ""}`,
						);
					}

					const candidate = responseData.candidates?.[0];
					if (candidate?.content?.parts) {
						for (const part of candidate.content.parts) {
							if (part.text !== undefined && part.text !== "") {
								sawContent = true;
								if (isThinkingPart(part)) {
									flushLeakBuffer();
									const block = startThinkingBlock();
									block.thinking += part.text;
									block.thinkingSignature = retainThoughtSignature(
										block.thinkingSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "thinking_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								} else if (
									isLeakModel &&
									(isBuffering || part.text.trimStart().startsWith("{"))
								) {
									isBuffering = true;
									textBuffer += part.text;
									bufferedSignature = retainThoughtSignature(
										bufferedSignature,
										part.thoughtSignature,
									);
									const buffered = consumePlanningBuffer(textBuffer, toolNames);
									if (buffered.kind !== "incomplete") {
										isBuffering = false;
										textBuffer = "";
										const signature = bufferedSignature;
										bufferedSignature = undefined;
										emitText(buffered.visibleText, signature);
									}
								} else {
									emitText(part.text, part.thoughtSignature);
								}
							} else if (
								part.text === "" &&
								part.thoughtSignature &&
								!part.functionCall
							) {
								if (currentBlock?.type === "thinking") {
									currentBlock.thinkingSignature = retainThoughtSignature(
										currentBlock.thinkingSignature,
										part.thoughtSignature,
									);
								} else if (currentBlock?.type === "text") {
									currentBlock.textSignature = retainThoughtSignature(
										currentBlock.textSignature,
										part.thoughtSignature,
									);
								}
							}

							if (part.functionCall) {
								flushLeakBuffer();
								endCurrentBlock();
								sawContent = true;
								const providedId = part.functionCall.id;
								const needsNewId =
									!providedId ||
									output.content.some(
										(b) => b.type === "toolCall" && b.id === providedId,
									);
								const toolCallId = needsNewId
									? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
									: providedId;
								const toolCall = {
									type: "toolCall" as const,
									id: toolCallId,
									name: part.functionCall.name || "",
									arguments: part.functionCall.args ?? {},
									...(part.thoughtSignature && {
										thoughtSignature: part.thoughtSignature,
									}),
								};
								blocks.push(toolCall);
								ensureStarted();
								stream.push({
									type: "toolcall_start",
									contentIndex: blockIndex(),
									partial: output,
								});
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta: JSON.stringify(toolCall.arguments),
									partial: output,
								});
								stream.push({
									type: "toolcall_end",
									contentIndex: blockIndex(),
									toolCall,
									partial: output,
								});
							}
						}
					}

					if (candidate?.finishReason) {
						output.rawStopReason = candidate.finishReason;
						output.stopReason = mapStopReasonString(candidate.finishReason);
						if (
							output.content.some((b) => b.type === "toolCall") &&
							output.stopReason === "stop"
						) {
							output.stopReason = "toolUse";
						}
					}

					if (responseData.usageMetadata) {
						const u = responseData.usageMetadata;
						const promptTokens = u.promptTokenCount || 0;
						const cacheRead = u.cachedContentTokenCount || 0;
						const thinking = u.thoughtsTokenCount || 0;
						output.usage = {
							input: promptTokens - cacheRead,
							output: (u.candidatesTokenCount || 0) + thinking,
							cacheRead,
							cacheWrite: 0,
							totalTokens: u.totalTokenCount || 0,
							...(thinking > 0 ? { reasoning: thinking } : {}),
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
						calculateCost(model, output.usage);
					}
				}

				flushLeakBuffer();
				endCurrentBlock();
				if (isAntigravity) {
					antigravitySession.lastExecutionId = lastResponseId;
				}
				return sawContent;
			};

			// Endpoint failover (antigravity: daily → sandbox) + bounded retries
			// for eventless 200s (CCA occasionally returns empty streams).
			const MAX_EMPTY_RETRIES = 3;
			let succeeded = false;
			for (
				let endpointIndex = 0;
				endpointIndex < endpoints.length && !succeeded;
				endpointIndex++
			) {
				const endpoint = endpoints[endpointIndex]!;
				const isLastEndpoint = endpointIndex === endpoints.length - 1;
				for (let attempt = 0; ; attempt++) {
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
						if (!isLastEndpoint && isRetriableTransportError(err)) break; // next endpoint
						throw err;
					}

					if (!response.ok) {
						const errorText = await response.text().catch(() => "");
						if (isRetriableStatus(response.status) && attempt < MAX_EMPTY_RETRIES) {
							await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, options?.signal);
							resetOutput();
							continue;
						}
						if (!isLastEndpoint && isRetriableStatus(response.status)) break; // next endpoint
						throw new Error(
							`Cloud Code Assist API error (${response.status}): ${errorText}`,
						);
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

					if (output.stopReason !== "pending" || meaningful) {
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
				throw new Error(
					output.errorMessage ||
						`Generation failed with finish reason: ${output.rawStopReason}`,
				);
			}
			if (output.content.length === 0) {
				throw new Error("Cloud Code Assist API returned an empty response");
			}

			// SAFETY: attach extra performance timing metadata to output object
			(output as unknown as Record<string, unknown>).duration =
				performance.now() - startTime;
			if (firstTokenTime) {
				// SAFETY: attach ttft timing metadata to output object
				(output as unknown as Record<string, unknown>).ttft =
					firstTokenTime - startTime;
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			// SAFETY: attach extra performance timing metadata to output object
			(output as unknown as Record<string, unknown>).duration =
				performance.now() - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// ---------------------------------------------------------------------------
// Registration: add OAuth to the built-in `google` provider. No models are
// declared — pi's own google catalog is kept untouched.
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("google", {
		name: "Google (Cloud Code Assist OAuth)",
		api: "google-generative-ai",
		streamSimple: streamGoogleCca,
		oauth: {
			name: "Google (Cloud Code Assist)",
			login: loginGoogle,
			refreshToken: refreshGoogleToken,
			getApiKey: googleCredentialApiKey,
		},
	});
}
