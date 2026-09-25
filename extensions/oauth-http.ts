/**
 * HTTP plumbing for the OAuth flows: a timeout-bounded fetch, JSON POST, the
 * long-running-operation poller and an abort-aware sleep.
 * Split out of `oauth.ts`.
 */
import { OAUTH_REQUEST_TIMEOUT_MS, OAuthFlowError, type GeminiCliLoadPayload, type LongRunningOperation } from "./oauth-types.ts";

export async function oauthFetch(
	url: string,
	init: RequestInit,
	signal: AbortSignal | undefined,
): Promise<Response> {
	if (signal?.aborted) throw new OAuthFlowError("Login cancelled", "cancelled");
	const timeoutSignal = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	try {
		return await fetch(url, { ...init, signal: requestSignal });
	} catch (err) {
		if (signal?.aborted) throw new OAuthFlowError("Login cancelled", "cancelled");
		if (timeoutSignal.aborted) {
			throw new OAuthFlowError(
				`Timed out after ${OAUTH_REQUEST_TIMEOUT_MS}ms waiting for ${url}`,
				"timeout",
			);
		}
		throw err;
	}
}

export async function postJson(
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	const res = await oauthFetch(
		url,
		{
			method: "POST",
			headers,
			body: JSON.stringify(body),
		},
		signal,
	);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new OAuthFlowError(
			`Request to ${url} failed with HTTP ${res.status}: ${text}`,
			"provisioning",
			res.status,
		);
	}
	return res.json();
}

export async function pollOperation(
	baseUrl: string,
	operationName: string,
	headers: Record<string, string>,
	signal: AbortSignal | undefined,
	onProgress: ((m: string) => void) | undefined,
	maxAttempts: number,
	intervalMs: number,
): Promise<LongRunningOperation> {
	for (let i = 0; i < maxAttempts; i++) {
		await sleepUnlessAborted(intervalMs, signal);
		onProgress?.(`Provisioning in progress (attempt ${i + 1}/${maxAttempts})...`);
		const res = await oauthFetch(
			`${baseUrl}/v1internal/${operationName}`,
			{ method: "GET", headers },
			signal,
		);
		if (res.status !== 200) {
			throw new OAuthFlowError(
				`Operation poll failed: ${res.status} ${res.statusText}`,
				"provisioning",
				res.status,
			);
		}
		const op = (await res.json()) as LongRunningOperation;
		if (op.done) return op;
	}
	throw new OAuthFlowError("Operation timed out waiting for completion", "timeout");
}

export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new OAuthFlowError("Login cancelled", "cancelled"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new OAuthFlowError("Login cancelled", "cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function isVpcScAffectedUser(payload: unknown): boolean {
	if (!payload || typeof payload !== "object") return false;
	const res = payload as GeminiCliLoadPayload;
	return Boolean(
		res.ineligibleTiers?.some(
			(t) =>
				t.reasonCode === "SECURITY_POLICY_VIOLATION" ||
				t.reasonMessage?.toLowerCase().includes("vpc-sc"),
		),
	);
}

// ---------------------------------------------------------------------------
// Loopback callback server
// ---------------------------------------------------------------------------
