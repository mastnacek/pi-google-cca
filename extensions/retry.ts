// Credential parsing plus HTTP retry/backoff.
import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import { MAX_RETRIES, REQUEST_TIMEOUT_MS, RETRY_BASE_DELAY_MS } from "./endpoints.ts";
import type { GoogleVariantId } from "./oauth.ts";
export interface ParsedCredential {
	token: string;
	projectId: string;
	variant: GoogleVariantId;
}

export function parseStoredCredential(apiKey: string | undefined): ParsedCredential {
	if (!apiKey) {
		throw new Error(
			"No Google Cloud Code Assist credentials found. Run `/login google` in the terminal first.",
		);
	}

	try {
		const parsed = JSON.parse(apiKey) as {
			token?: string;
			access?: string;
			projectId?: string;
			project_id?: string;
			variant?: GoogleVariantId;
		};
		const token = parsed.token || parsed.access;
		const projectId = parsed.projectId || parsed.project_id;
		if (token && projectId) {
			return {
				token,
				projectId,
				variant: parsed.variant || "antigravity",
			};
		}
	} catch {
		// Not JSON, fall through
	}

	throw new Error(
		"Google Cloud Code Assist requires OAuth credentials. Run `/login google` to authenticate.",
	);
}

export function isRetriableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

export function isRetriableTransportError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const msg = (err as Error).message || "";
	return (
		msg.includes("fetch failed") ||
		msg.includes("ECONNRESET") ||
		msg.includes("ETIMEDOUT") ||
		msg.includes("ECONNREFUSED") ||
		msg.includes("UND_ERR_SOCKET")
	);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("Request was aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export async function doFetchWithRetry(
	url: string,
	init: RequestInit,
	options?: SimpleStreamOptions,
): Promise<Response> {
	const fetchImpl = options?.fetch ?? fetch;
	let lastError: unknown;
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), options?.signal);
		}
		try {
			const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const signal = options?.signal
				? AbortSignal.any([options.signal, timeoutSignal])
				: timeoutSignal;
			const response = await fetchImpl(url, { ...init, signal });
			if (!response.ok && isRetriableStatus(response.status) && attempt < MAX_RETRIES) {
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
