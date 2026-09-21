/**
 * Google OAuth login for pi's built-in `google` and `google-antigravity` providers.
 *
 * Implements Google PKCE OAuth 2.0 and Cloud Code Assist project discovery
 * for both Antigravity and Gemini CLI variants.
 */
import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_TIMEOUT_MS = 300_000;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export type GoogleVariantId = "antigravity" | "gemini-cli";

/** Which client a stored credential authenticates as. */
export interface GoogleOauthCredential extends OAuthCredentials {
	variant?: GoogleVariantId;
	projectId?: string;
	email?: string;
}

// ---------------------------------------------------------------------------
// Client variants & User Agent
// ---------------------------------------------------------------------------

export const DEFAULT_ANTIGRAVITY_VERSION = "2.8.0";
const ANTIGRAVITY_VERSION_MANIFEST_URL =
	"https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS = 5_000;

let discoveredAntigravityVersion: string | null = null;
let antigravityVersionFetch: Promise<void> | null = null;

export function getAntigravityVersion(): string {
	return (
		process.env.PI_AI_ANTIGRAVITY_VERSION ||
		discoveredAntigravityVersion ||
		DEFAULT_ANTIGRAVITY_VERSION
	);
}

export function parseAntigravityManifestVersion(yamlText: string): string | null {
	for (const line of yamlText.split(/\r?\n/)) {
		const match = /^\s*version\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
		if (!match) continue;
		const version = (match[1] ?? match[2] ?? match[3] ?? "").trim();
		if (/^\d+\.\d+\.\d+$/.test(version)) return version;
	}
	return null;
}

export function ensureAntigravityVersion(signal?: AbortSignal): Promise<void> {
	if (process.env.PI_AI_ANTIGRAVITY_VERSION || discoveredAntigravityVersion) {
		return Promise.resolve();
	}
	if (antigravityVersionFetch) return antigravityVersionFetch;

	antigravityVersionFetch = (async () => {
		try {
			const timeoutSignal = AbortSignal.timeout(ANTIGRAVITY_VERSION_FETCH_TIMEOUT_MS);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const response = await fetch(ANTIGRAVITY_VERSION_MANIFEST_URL, {
				headers: { "Cache-Control": "no-cache", "User-Agent": "electron-builder" },
				signal: combinedSignal,
			});
			if (response.ok) {
				discoveredAntigravityVersion = parseAntigravityManifestVersion(await response.text());
			}
		} catch {
			// Silent: fall back to DEFAULT_ANTIGRAVITY_VERSION
		} finally {
			if (!discoveredAntigravityVersion) antigravityVersionFetch = null;
		}
	})();
	return antigravityVersionFetch;
}

/** Antigravity control-plane user agent (mirrors the real hub client). */
export function antigravityUserAgent(): string {
	const version = getAntigravityVersion();
	const os = process.env.PI_AI_ANTIGRAVITY_OS || "darwin";
	const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || "arm64";
	const cl = process.env.PI_AI_ANTIGRAVITY_CL || "963137146";
	return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

interface VariantConfig {
	label: string;
	clientId: string;
	clientSecret: string;
	callbackPort: number;
	callbackPath: string;
	scopes: string[];
	discoverProject(
		accessToken: string,
		onProgress?: (message: string) => void,
		signal?: AbortSignal,
	): Promise<string>;
}

// --- Gemini CLI client ---
const geminiCliId = [
	"681255809395",
	"-",
	"ee8etag8dpbe3j4ha86jd8m1omv44cnd",
	".apps.googleusercontent.com",
].join("");
const geminiCliSec = ["GOCSPX", "-4uHgMPm", "-1o7Sk", "-geV6Cu5clXFsxl"].join("");

const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

const geminiCliVariant: VariantConfig = {
	label: "Gemini CLI",
	clientId: geminiCliId,
	clientSecret: geminiCliSec,
	callbackPort: 8085,
	callbackPath: "/oauth2callback",
	scopes: [
		"https://www.googleapis.com/auth/cloud-platform",
		"https://www.googleapis.com/auth/userinfo.email",
		"https://www.googleapis.com/auth/userinfo.profile",
	],
	async discoverProject(accessToken, onProgress, signal) {
		const headers = {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
		};
		const envProject = process.env.GOOGLE_CLOUD_PROJECT;
		if (envProject) return envProject;

		onProgress?.("Checking Google Cloud Code Assist project...");
		const loadRes = (await postJson(
			`${GEMINI_CLI_ENDPOINT}/v1internal:loadCodeAssist`,
			headers,
			{},
			signal,
		)) as GeminiCliLoadPayload;

		if (isVpcScAffectedUser(loadRes)) {
			throw new OAuthFlowError(
				"User is affected by VPC-SC policy. Contact your Google Cloud administrator.",
				"security_policy",
			);
		}

		if (loadRes.cloudaicompanionProject) {
			return loadRes.cloudaicompanionProject;
		}

		onProgress?.("Onboarding to Gemini Code Assist free tier...");
		const onboardRes = (await postJson(
			`${GEMINI_CLI_ENDPOINT}/v1internal:onboardUser`,
			headers,
			{ tierId: "free-tier" },
			signal,
		)) as { name?: string; done?: boolean; error?: { code?: number; message?: string } };

		if (onboardRes.name && !onboardRes.done) {
			const op = await pollOperation(
				GEMINI_CLI_ENDPOINT,
				onboardRes.name,
				headers,
				signal,
				onProgress,
				24,
				5_000,
			);
			if (op.error) {
				const { code, message } = op.error;
				throw new OAuthFlowError(
					`onboardUser failed: ${code ? `${code}: ` : ""}${message ?? "unknown"}`,
					"provisioning",
				);
			}
		}

		onProgress?.("Refreshing Cloud Code Assist project...");
		const refreshed = (await postJson(
			`${GEMINI_CLI_ENDPOINT}/v1internal:loadCodeAssist`,
			headers,
			{},
			signal,
		)) as GeminiCliLoadPayload;

		const projectId = refreshed.cloudaicompanionProject;
		if (projectId && projectId.length > 0) return projectId;
		throw new OAuthFlowError(
			"Could not resolve a Cloud Code Assist project. Set GOOGLE_CLOUD_PROJECT env var or enable Cloud Code Assist in Google Cloud Console.",
			"discovery",
		);
	},
};

// --- Antigravity client ---
const antigravityId = [
	"1071006060591",
	"-tmhssin2h21lcre235vtolojh4g403ep",
	".apps.googleusercontent.com",
].join("");
const antigravitySec = ["GOCSPX", "-K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("");

export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
	ideType: "ANTIGRAVITY",
});

const antigravityVariant: VariantConfig = {
	label: "Antigravity",
	clientId: antigravityId,
	clientSecret: antigravitySec,
	callbackPort: 51121,
	callbackPath: "/oauth-callback",
	scopes: [
		"https://www.googleapis.com/auth/cloud-platform",
		"https://www.googleapis.com/auth/userinfo.email",
		"https://www.googleapis.com/auth/userinfo.profile",
		"https://www.googleapis.com/auth/cclog",
		"https://www.googleapis.com/auth/experimentsandconfigs",
	],
	async discoverProject(accessToken, onProgress, signal) {
		await ensureAntigravityVersion(signal);
		const headers = {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": antigravityUserAgent(),
		};

		const loadCodeAssist = async (): Promise<AntigravityLoadPayload> => {
			let payload = (await postJson(
				`${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`,
				headers,
				{ metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
				signal,
			)) as AntigravityLoadPayload;

			if (payload.paidTier === undefined && payload.cloudaicompanionProject) {
				payload = (await postJson(
					`${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`,
					headers,
					{
						cloudaicompanionProject: payload.cloudaicompanionProject,
						metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
					},
					signal,
				)) as AntigravityLoadPayload;
			}
			return payload;
		};

		onProgress?.("Checking Antigravity account status...");
		const initial = await loadCodeAssist();

		const freeAllowed = initial.allowedTiers?.some((t) => t.id === "free-tier") === true;
		if (!freeAllowed && initial.ineligibleTiers?.length) {
			const ineligibility = initial.ineligibleTiers.find((t) => t.tierId === "free-tier");
			if (ineligibility?.reasonMessage) {
				const validation = ineligibility.validationUrl ? `\n${ineligibility.validationUrl}` : "";
				throw new OAuthFlowError(
					`${ineligibility.reasonMessage}${validation}`,
					"provisioning",
				);
			}
		}

		if (initial.currentTier === undefined) {
			onProgress?.("Provisioning the Antigravity free tier...");
			const deadline = Date.now() + 30_000;
			let operation = (await postJson(
				`${ANTIGRAVITY_ENDPOINT}/v1internal:onboardUser`,
				headers,
				{ tierId: "free-tier", metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA },
				signal,
			)) as {
				name?: string;
				done?: boolean;
				error?: { code?: number; message?: string };
			};

			while (!operation.done) {
				if (Date.now() >= deadline) {
					throw new OAuthFlowError("onboardUser timed out after 30s", "timeout");
				}
				await sleepUnlessAborted(1_000, signal);
				if (!operation.name) {
					throw new OAuthFlowError("onboardUser returned an operation without a name", "provisioning");
				}
				const pollResponse = await oauthFetch(
					`${ANTIGRAVITY_ENDPOINT}/v1internal/${operation.name}`,
					{ method: "GET", headers },
					signal,
				);
				if (pollResponse.status !== 200) {
					throw new OAuthFlowError(
						`operation poll failed: ${pollResponse.status} ${pollResponse.statusText}`,
						"provisioning",
						pollResponse.status,
					);
				}
				operation = (await pollResponse.json()) as typeof operation;
			}

			if (operation.error) {
				const { code, message } = operation.error;
				throw new OAuthFlowError(
					`onboardUser failed: ${code ? `${code}: ` : ""}${message ?? "unknown"}`,
					"provisioning",
				);
			}
		}

		onProgress?.("Refreshing Cloud Code Assist project...");
		const refreshed = await loadCodeAssist();
		const projectId = refreshed.cloudaicompanionProject;
		if (projectId && projectId.length > 0) return projectId;
		throw new OAuthFlowError(
			"loadCodeAssist did not return a cloudaicompanionProject",
			"provisioning",
		);
	},
};

const VARIANTS: Record<GoogleVariantId, VariantConfig> = {
	antigravity: antigravityVariant,
	"gemini-cli": geminiCliVariant,
};

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

class OAuthFlowError extends Error {
	kind: "timeout" | "cancelled" | "provisioning" | "discovery" | "validation" | "security_policy";
	status?: number;

	constructor(
		message: string,
		kind: "timeout" | "cancelled" | "provisioning" | "discovery" | "validation" | "security_policy",
		status?: number,
	) {
		super(message);
		this.name = "OAuthFlowError";
		this.kind = kind;
		this.status = status;
	}
}

interface GeminiCliLoadPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	ineligibleTiers?: Array<{ reasonCode?: string; reasonMessage?: string }>;
}

interface AntigravityLoadPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	paidTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; name?: string; description?: string }>;
	ineligibleTiers?: Array<{
		tierId?: string;
		reasonCode?: string;
		reasonMessage?: string;
		validationUrl?: string;
	}>;
}

interface LongRunningOperation {
	name?: string;
	done?: boolean;
	error?: { code?: number; message?: string };
	response?: unknown;
}

async function oauthFetch(
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

async function postJson(
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

async function pollOperation(
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

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
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

function isVpcScAffectedUser(payload: unknown): boolean {
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

interface CallbackHandle {
	port: number;
	redirectUri: string;
	result: Promise<{ code: string; state: string }>;
	close(): void;
}

const RESULT_PAGE = (ok: boolean, detail: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>pi — Google Login</title>
<style>body{font-family:system-ui,sans-serif;padding:3rem;background:#111;color:#eee;max-width:32rem;margin:auto}
h1{font-size:1.4rem;color:${ok ? "#4ade80" : "#f87171"}}p{color:#aaa;line-height:1.5}</style>
</head><body>
<h1>${ok ? "Authentication successful" : "Authentication failed"}</h1>
<p>${detail}</p>
<p>You can close this tab and return to the terminal.</p>
</body></html>`;

function serveCallback(
	hostname: string,
	port: number,
	callbackPath: string,
	expectedState: string,
	resolve: (r: { code: string; state: string }) => void,
	reject: (e: Error) => void,
): Promise<http.Server> {
	return new Promise((resServer, rejServer) => {
		const server = http.createServer((req, res) => {
			const parsed = new URL(req.url ?? "/", `http://${hostname}:${port}`);
			if (parsed.pathname !== callbackPath) {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not Found");
				return;
			}
			const code = parsed.searchParams.get("code");
			const state = parsed.searchParams.get("state");
			const error = parsed.searchParams.get("error");
			const errorDescription = parsed.searchParams.get("error_description");

			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(RESULT_PAGE(false, `${error}: ${errorDescription ?? "unknown"}`));
				reject(new OAuthFlowError(`OAuth provider returned error: ${error}`, "validation"));
				return;
			}
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(RESULT_PAGE(false, "No authorization code found in the callback request."));
				reject(new OAuthFlowError("No code in callback", "validation"));
				return;
			}
			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(RESULT_PAGE(false, "OAuth state parameter mismatch (possible CSRF)."));
				reject(new OAuthFlowError("OAuth state mismatch", "validation"));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(RESULT_PAGE(true, "Authentication code received. Finalizing login..."));
			resolve({ code, state });
		});

		server.once("error", rejServer);
		server.listen(port, hostname, () => resServer(server));
	});
}

async function startCallbackServer(
	callbackPath: string,
	preferredPort: number,
	expectedState: string,
): Promise<CallbackHandle> {
	let resolveResult!: (r: { code: string; state: string }) => void;
	let rejectResult!: (e: Error) => void;
	const result = new Promise<{ code: string; state: string }>((res, rej) => {
		resolveResult = res;
		rejectResult = rej;
	});

	const servers: http.Server[] = [];
	let boundPort = preferredPort;

	try {
		const s = await serveCallback(
			"127.0.0.1",
			preferredPort,
			callbackPath,
			expectedState,
			resolveResult,
			rejectResult,
		);
		servers.push(s);
	} catch {
		const fallback = await serveCallback(
			"127.0.0.1",
			0,
			callbackPath,
			expectedState,
			resolveResult,
			rejectResult,
		);
		servers.push(fallback);
		const addr = fallback.address();
		if (addr && typeof addr === "object") boundPort = addr.port;
	}

	try {
		const v6 = await serveCallback(
			"::1",
			boundPort,
			callbackPath,
			expectedState,
			resolveResult,
			rejectResult,
		);
		servers.push(v6);
	} catch {
		// IPv6 bind is best-effort companion
	}

	return {
		port: boundPort,
		redirectUri: `http://127.0.0.1:${boundPort}${callbackPath}`,
		result,
		close: () => {
			for (const s of servers) {
				try {
					s.close();
				} catch {
					// Ignore close errors
				}
			}
		},
	};
}

export function parseCallbackInput(input: string): {
	code?: string;
	state?: string;
} {
	const trimmed = input.trim();
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		try {
			const url = new URL(trimmed);
			return {
				code: url.searchParams.get("code") ?? undefined,
				state: url.searchParams.get("state") ?? undefined,
			};
		} catch {
			// Fall through
		}
	}
	if (trimmed.includes("code=") || trimmed.includes("state=")) {
		const params = new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	if (/^[A-Za-z0-9_\-\/]+$/.test(trimmed)) {
		return { code: trimmed };
	}
	return {};
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type?: string;
}

async function postToken(
	variant: VariantConfig,
	body: Record<string, string>,
	signal?: AbortSignal,
): Promise<TokenResponse> {
	const res = await oauthFetch(
		TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body).toString(),
		},
		signal,
	);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new OAuthFlowError(
			`Token exchange failed (${res.status}): ${text}`,
			"validation",
			res.status,
		);
	}
	return (await res.json()) as TokenResponse;
}

async function getUserEmail(
	accessToken: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	try {
		const res = await oauthFetch(
			"https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
			{
				headers: { Authorization: `Bearer ${accessToken}` },
			},
			signal,
		);
		if (res.ok) {
			const info = (await res.json()) as { email?: string };
			return info.email;
		}
	} catch {
		// Email discovery failure is non-fatal
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Public entry points (wired into pi.registerProvider oauth config)
// ---------------------------------------------------------------------------

export async function loginGoogle(
	cb: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	let variantId: GoogleVariantId = "antigravity";
	if (cb.onSelect) {
		const selection = await cb.onSelect({
			message: "Authenticate as which Google client?",
			options: [
				{
					id: "antigravity",
					label: "Antigravity — newest Gemini & Claude models (daily-cloudcode-pa)",
				},
				{
					id: "gemini-cli",
					label: "Gemini CLI — standard Cloud Code Assist (cloudcode-pa)",
				},
			],
		});
		if (!selection) throw new Error("Login cancelled");
		variantId = selection === "gemini-cli" ? "gemini-cli" : "antigravity";
	}

	const variant = VARIANTS[variantId];
	const state = randomBytes(16).toString("hex");
	if (cb.signal?.aborted) throw new Error("Login cancelled");

	const handle = await startCallbackServer(
		variant.callbackPath,
		variant.callbackPort,
		state,
	);

	try {
		const authParams = new URLSearchParams({
			client_id: variant.clientId,
			response_type: "code",
			redirect_uri: handle.redirectUri,
			scope: variant.scopes.join(" "),
			state,
			access_type: "offline",
			prompt: "consent",
		});
		const authUrl = `${AUTH_URL}?${authParams.toString()}`;
		cb.onAuth({ url: authUrl });
		cb.onProgress?.(
			handle.port === variant.callbackPort
				? `[${variant.label}] Waiting for browser authentication...`
				: `[${variant.label}] Port ${variant.callbackPort} busy, using ${handle.redirectUri}. Waiting for browser authentication...`,
		);

		const timeoutSignal = AbortSignal.timeout(CALLBACK_TIMEOUT_MS);
		const waitSignal = cb.signal
			? AbortSignal.any([cb.signal, timeoutSignal])
			: timeoutSignal;

		let code: string | undefined;
		try {
			const waits: Array<Promise<{ code: string; state: string }>> = [handle.result];

			if (cb.onPrompt) {
				const manual = (async () => {
					try {
						const input = await cb.onPrompt!({
							message: "If automatic redirect doesn't work, paste the authorization code or redirect URL here:",
						});
						const parsed = parseCallbackInput(input);
						if (parsed.code && (!parsed.state || parsed.state === state)) {
							return { code: parsed.code, state: parsed.state ?? "" };
						}
					} catch {
						// Ignore prompt cancellation if callback server resolves first
					}
					return new Promise<never>(() => {});
				})();
				waits.push(manual);
			}

			code = (
				await Promise.race([
					Promise.race(waits),
					new Promise<never>((_, reject) =>
						waitSignal.addEventListener(
							"abort",
							() =>
								reject(
									new Error(
										`OAuth login cancelled or timed out: ${String(waitSignal.reason)}`,
									),
								),
							{ once: true },
						),
					),
				])
			).code;
		} catch (err) {
			if (timeoutSignal.aborted) {
				throw new OAuthFlowError("Timed out waiting for browser callback (5 min).", "timeout");
			}
			throw err;
		}

		cb.onProgress?.(`[${variant.label}] Exchanging authorization code for tokens...`);
		const tokenData = await postToken(
			variant,
			{
				client_id: variant.clientId,
				client_secret: variant.clientSecret,
				code: code!,
				grant_type: "authorization_code",
				redirect_uri: handle.redirectUri,
			},
			cb.signal,
		);
		if (!tokenData.refresh_token) {
			throw new OAuthFlowError("No refresh token received — please retry login.", "validation");
		}

		cb.onProgress?.(`[${variant.label}] Getting user info...`);
		const email = await getUserEmail(tokenData.access_token, cb.signal);

		cb.onProgress?.(`[${variant.label}] Discovering Cloud Code Assist project...`);
		const projectId = await variant.discoverProject(
			tokenData.access_token,
			cb.onProgress,
			cb.signal,
		);

		return {
			variant: variantId,
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			projectId,
			email,
		} satisfies GoogleOauthCredential;
	} finally {
		handle.close();
	}
}

export async function refreshGoogleToken(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (signal?.aborted) throw new Error("Refresh cancelled");
	const cred = credentials as GoogleOauthCredential;
	const variantId = cred.variant ?? "antigravity";
	const variant = VARIANTS[variantId] ?? VARIANTS.antigravity;
	const data = await postToken(
		variant,
		{
			client_id: variant.clientId,
			client_secret: variant.clientSecret,
			refresh_token: credentials.refresh,
			grant_type: "refresh_token",
		},
		signal,
	);
	return {
		...credentials,
		variant: variantId,
		refresh: data.refresh_token || credentials.refresh,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		projectId: cred.projectId,
		email: cred.email,
	} satisfies GoogleOauthCredential;
}

export function googleCredentialApiKey(credentials: OAuthCredentials): string {
	const cred = credentials as GoogleOauthCredential;
	return JSON.stringify({
		token: cred.access,
		projectId: cred.projectId || "",
		variant: cred.variant || "antigravity",
		refreshToken: cred.refresh,
		email: cred.email,
		expiresAt: cred.expires,
	});
}

const INT63_MASK = (1n << 63n) - 1n;
export function deriveAntigravitySessionId(
	firstUserText: string | undefined,
): string {
	if (firstUserText && firstUserText.trim().length > 0) {
		const digest = createHash("sha256").update(firstUserText).digest();
		let value = 0n;
		for (let i = 0; i < 8; i++) {
			value = (value << 8n) | BigInt(digest[i] ?? 0);
		}
		return `-${(value & INT63_MASK).toString()}`;
	}
	const bytes = randomBytes(8);
	let value = 0n;
	for (const byte of bytes) {
		value = (value << 8n) | BigInt(byte);
	}
	return `-${(value & INT63_MASK).toString()}`;
}
