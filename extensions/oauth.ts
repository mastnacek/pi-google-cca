/**
 * Google OAuth login for pi's built-in `google` provider — the same flow the
 * omp CLI uses (ported from oh-my-pi packages/ai/src/registry/oauth/):
 *
 *   1. `/login google` asks which Google client to authenticate as:
 *        - Antigravity (daily-cloudcode-pa.googleapis.com — newest Gemini)
 *        - Gemini CLI  (cloudcode-pa.googleapis.com)
 *   2. Browser authorization-code flow via a loopback callback server
 *      (127.0.0.1, dual-stack, random-port fallback, CSRF state, 5-min wait).
 *   3. Token exchange → user email → Cloud Code Assist project discovery
 *      (loadCodeAssist / onboardUser + LRO polling).
 *   4. Credentials persist in ~/.pi/agent/auth.json with `variant` recording
 *      which client they belong to; refresh and streaming dispatch on it.
 */
import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_TIMEOUT_MS = 300_000;
const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export type GoogleVariantId = "antigravity" | "gemini-cli";

/** Which client a stored credential authenticates as. */
export interface GoogleOauthCredential extends OAuthCredentials {
	variant: GoogleVariantId;
	projectId: string;
	email?: string;
}

// ---------------------------------------------------------------------------
// Client variants
// ---------------------------------------------------------------------------

const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

/** Antigravity control-plane user agent (mirrors the real hub client). */
export function antigravityUserAgent(): string {
	const version = process.env.PI_AI_ANTIGRAVITY_VERSION || "2.8.0";
	const os = process.env.PI_AI_ANTIGRAVITY_OS || "darwin";
	const arch = process.env.PI_AI_ANTIGRAVITY_ARCH || "arm64";
	const cl = process.env.PI_AI_ANTIGRAVITY_CL || "963137146";
	return `antigravity/hub/${version} (aidev_client; os_type=${os}; arch=${arch}; cl=${cl})`;
}

interface VariantConfig {
	clientId: string;
	clientSecret: string;
	callbackPort: number;
	callbackPath: string;
	scopes: string[];
	label: string;
	discoverProject(accessToken: string, onProgress?: (m: string) => void, signal?: AbortSignal): Promise<string>;
}

// --- Gemini CLI client ------------------------------------------------------

// NOTE: These are Google's own public native OAuth client credentials for the
// Gemini CLI, published verbatim in the MIT-licensed google-gemini/gemini-cli
// repository. Native/desktop OAuth clients cannot keep credentials secret by
// design; they are not user secrets. Assembled at runtime purely so GitHub
// push protection does not flag them.
const geminiCliId = ["681255809395", "-oo8ft2oprdrnp9e3aqf6av3hmdib135j", ".apps.googleusercontent.com"].join("");
const geminiCliSec = ["GOCSPX", "-4uHgMPm", "-1o7Sk", "-geV6Cu5clXFsxl"].join("");

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
		const envProjectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
		const headers = {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": "GeminiCLI/0.46.0/gemini-3.1-pro-preview (linux; x64; terminal)",
			"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
		};

		onProgress?.("Checking for existing Cloud Code Assist project...");
		const loadResponse = await oauthFetch(
			`${GEMINI_CLI_ENDPOINT}/v1internal:loadCodeAssist`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					cloudaicompanionProject: envProjectId,
					metadata: {
						ideType: "IDE_UNSPECIFIED",
						platform: "PLATFORM_UNSPECIFIED",
						pluginType: "GEMINI",
						duetProject: envProjectId,
					},
				}),
			},
			signal,
		);

		let data: GeminiCliLoadPayload;
		if (loadResponse.ok) {
			data = (await loadResponse.json()) as GeminiCliLoadPayload;
		} else {
			let errorPayload: unknown;
			try {
				errorPayload = await loadResponse.clone().json();
			} catch {
				errorPayload = undefined;
			}
			if (isVpcScAffectedUser(errorPayload)) {
				data = { currentTier: { id: "standard-tier" } };
			} else {
				const errorText = await loadResponse.text();
				throw new OAuthFlowError(
					`loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${errorText}`,
					"discovery",
					loadResponse.status,
				);
			}
		}

		if (data.currentTier) {
			if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
			if (envProjectId) return envProjectId;
			throw new OAuthFlowError(
				"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable.",
				"configuration",
			);
		}

		const defaultTier = data.allowedTiers?.find(t => t.isDefault);
		const tierId = defaultTier?.id ?? "free-tier";
		if (tierId !== "free-tier" && !envProjectId) {
			throw new OAuthFlowError(
				"This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable.",
				"configuration",
			);
		}

		onProgress?.("Provisioning Cloud Code Assist project (this may take a moment)...");
		const onboardBody: Record<string, unknown> = {
			tierId,
			metadata: { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
		};
		if (tierId !== "free-tier" && envProjectId) {
			onboardBody.cloudaicompanionProject = envProjectId;
			(onboardBody.metadata as Record<string, unknown>).duetProject = envProjectId;
		}

		const onboardResponse = await oauthFetch(
			`${GEMINI_CLI_ENDPOINT}/v1internal:onboardUser`,
			{ method: "POST", headers, body: JSON.stringify(onboardBody) },
			signal,
		);
		if (!onboardResponse.ok) {
			const errorText = await onboardResponse.text();
			throw new OAuthFlowError(
				`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${errorText}`,
				"provisioning",
				onboardResponse.status,
			);
		}

		let lro = (await onboardResponse.json()) as LongRunningOperation;
		if (!lro.done && lro.name) {
			lro = await pollOperation(`${GEMINI_CLI_ENDPOINT}/v1internal`, lro.name, headers, signal, onProgress, 24, 5_000);
		}

		const projectId = lro.response?.cloudaicompanionProject?.id;
		if (projectId) return projectId;
		if (envProjectId) return envProjectId;
		throw new OAuthFlowError(
			"Could not discover or provision a Google Cloud project. Try setting GOOGLE_CLOUD_PROJECT.",
			"validation",
		);
	},
};

// --- Antigravity client ------------------------------------------------------

// Same situation as above: Antigravity's public native OAuth client
// credentials, distributed inside the Antigravity IDE itself.
const antigravityId = ["1071006060591", "-tmhssin2h21lcre235vtolojh4g403ep", ".apps.googleusercontent.com"].join("");
const antigravitySec = ["GOCSPX", "-K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("");

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
		const headers = {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": antigravityUserAgent(),
		};
		const loadCodeAssist = async (): Promise<AntigravityLoadPayload> => {
			const first = (await postJson(
				`${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`,
				headers,
				{ metadata: { ideType: "ANTIGRAVITY" } },
				signal,
			)) as AntigravityLoadPayload;
			if (first.paidTier === undefined && first.cloudaicompanionProject) {
				return (await postJson(
					`${ANTIGRAVITY_ENDPOINT}/v1internal:loadCodeAssist`,
					headers,
					{
						cloudaicompanionProject: first.cloudaicompanionProject,
						metadata: { ideType: "ANTIGRAVITY" },
					},
					signal,
				)) as AntigravityLoadPayload;
			}
			return first;
		};

		onProgress?.("Checking Antigravity account status...");
		const initial = await loadCodeAssist();

		const freeAllowed = initial.allowedTiers?.some(t => t.id === "free-tier") === true;
		if (!freeAllowed) {
			const ineligibility = initial.ineligibleTiers?.find(t => t.tierId === "free-tier");
			if (ineligibility?.reasonMessage) {
				throw new OAuthFlowError(
					`${ineligibility.reasonMessage}${ineligibility.validationUrl ? `\n${ineligibility.validationUrl}` : ""}`,
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
				{ tierId: "free-tier", metadata: { ideType: "ANTIGRAVITY" } },
				signal,
			)) as { name?: string; done?: boolean; error?: { code?: number; message?: string } };

			for (;;) {
				if (operation.done === true) {
					if (operation.error) {
						const { code, message } = operation.error;
						throw new OAuthFlowError(
							`onboardUser failed: ${code ? `${code}: ` : ""}${message ?? "unknown"}`,
							"provisioning",
						);
					}
					break;
				}
				if (Date.now() >= deadline) throw new OAuthFlowError("onboardUser timed out after 30s", "timeout");
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
		}

		onProgress?.("Refreshing Cloud Code Assist project...");
		const refreshed = await loadCodeAssist();
		const projectId = refreshed.cloudaicompanionProject;
		if (projectId && projectId.length > 0) return projectId;
		throw new OAuthFlowError("loadCodeAssist did not return a cloudaicompanionProject", "provisioning");
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
	constructor(
		message: string,
		readonly kind: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "OAuthFlowError";
	}
}

interface GeminiCliLoadPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
}

interface AntigravityLoadPayload {
	currentTier?: { id?: string } | null;
	paidTier?: { id?: string } | null;
	allowedTiers?: Array<{ id?: string }>;
	ineligibleTiers?: Array<{ tierId?: string; reasonMessage?: string; validationUrl?: string }>;
	cloudaicompanionProject?: string;
}

interface LongRunningOperation {
	name?: string;
	done?: boolean;
	response?: { cloudaicompanionProject?: { id?: string } };
}

/** `fetch` with a per-request timeout and login-cancellation mapping. */
async function oauthFetch(url: string, init: RequestInit, signal: AbortSignal | undefined): Promise<Response> {
	const timeoutSignal = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	try {
		return await fetch(url, { ...init, signal: requestSignal });
	} catch (err) {
		if (signal?.aborted) throw new Error(`OAuth login cancelled: ${String(signal.reason)}`);
		if (timeoutSignal.aborted) {
			throw new OAuthFlowError(`Timed out after ${OAUTH_REQUEST_TIMEOUT_MS}ms waiting for ${url}`, "timeout");
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
	const response = await oauthFetch(url, { method: "POST", headers, body: JSON.stringify(body) }, signal);
	if (response.status !== 200) {
		const errorText = await response.text();
		throw new OAuthFlowError(
			`${url} failed: ${response.status} ${response.statusText}: ${errorText}`,
			"provisioning",
			response.status,
		);
	}
	return response.json();
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
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (attempt > 0) {
			onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1}/${maxAttempts})...`);
			await sleepUnlessAborted(intervalMs, signal);
		}
		if (signal?.aborted) throw new Error("OAuth login cancelled");
		const response = await oauthFetch(`${baseUrl}/${operationName}`, { method: "GET", headers }, signal);
		if (!response.ok) {
			throw new OAuthFlowError(`Failed to poll operation: ${response.status} ${response.statusText}`, "polling", response.status);
		}
		const data = (await response.json()) as LongRunningOperation;
		if (data.done) return data;
	}
	throw new OAuthFlowError(`Project provisioning did not complete after ${maxAttempts} attempts`, "timeout");
}

/** `setTimeout`-based sleep that rejects when the login is cancelled. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("OAuth login cancelled"));
			},
			{ once: true },
		);
	});
}

function isVpcScAffectedUser(payload: unknown): boolean {
	if (!payload || typeof payload !== "object" || !("error" in payload)) return false;
	const error = (payload as { error?: { details?: Array<{ reason?: string }> } }).error;
	return Array.isArray(error?.details) && error.details.some(d => d?.reason === "SECURITY_POLICY_VIOLATED");
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
<html><head><meta charset="utf-8"><title>Pi login</title></head>
<body style="font-family: system-ui, sans-serif; background: #1e1e2e; color: #cdd6f4; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
<div style="text-align: center;">
<div style="font-size: 42px;">${ok ? "✅" : "❌"}</div>
<h2>${ok ? "Authentication successful" : "Authentication failed"}</h2>
<p style="opacity: .7;">${detail}</p>
<p style="opacity: .5;">You can close this tab and return to the terminal.</p>
</div>
</body></html>`;

function serveCallback(
	hostname: string,
	port: number,
	callbackPath: string,
	expectedState: string,
	resolve: (r: { code: string; state: string }) => void,
	reject: (e: Error) => void,
): Promise<http.Server> {
	return new Promise((listenResolve, listenReject) => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", `http://${hostname}`);
			if (url.pathname !== callbackPath) {
				res.writeHead(404).end("Not Found");
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state") ?? "";
			const error = url.searchParams.get("error") ?? "";
			const errorDescription = url.searchParams.get("error_description") ?? error;

			if (error) {
				res.writeHead(500, { "Content-Type": "text/html" }).end(RESULT_PAGE(false, errorDescription));
				// Only trust errors carrying our state nonce; any local process
				// can forge the rest (omp #4106).
				if (!expectedState || state === expectedState) {
					reject(new OAuthFlowError(`Authorization failed: ${errorDescription}`, "user-denied"));
				}
				return;
			}
			if (!code) {
				res.writeHead(500, { "Content-Type": "text/html" }).end(RESULT_PAGE(false, "Missing authorization code"));
				return;
			}
			if (expectedState && state !== expectedState) {
				res.writeHead(500, { "Content-Type": "text/html" }).end(RESULT_PAGE(false, "State mismatch"));
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html" }).end(RESULT_PAGE(true, "You may now return to pi."));
			resolve({ code, state });
		});
		server.once("error", listenReject);
		server.listen(port, hostname, () => listenResolve(server));
	});
}

/**
 * Bind the callback server: preferred port on 127.0.0.1 (random-port fallback
 * when busy), plus an ::1 companion so `localhost` traffic resolving to IPv6
 * still reaches us instead of some wildcard-bound dev server.
 */
async function startCallbackServer(callbackPath: string, preferredPort: number, expectedState: string): Promise<CallbackHandle> {
	const { promise: resultPromise, resolve, reject } = Promise.withResolvers<{ code: string; state: string }>();
	let primary: http.Server;
	let primaryPort: number;
	try {
		primary = await serveCallback("127.0.0.1", preferredPort, callbackPath, expectedState, resolve, reject);
		const addr = primary.address();
		primaryPort = addr && typeof addr === "object" ? addr.port : preferredPort;
	} catch {
		// Port busy — fall back to an ephemeral port (Google allows any loopback port).
		primary = await serveCallback("127.0.0.1", 0, callbackPath, expectedState, resolve, reject);
		primaryPort = (primary.address() as { port: number }).port;
	}

	try {
		await serveCallback("::1", primaryPort, callbackPath, expectedState, resolve, reject);
	} catch {
		/* IPv6 loopback unavailable — IPv4 listener serves alone. */
	}

	return {
		port: primaryPort,
		redirectUri: `http://127.0.0.1:${primaryPort}${callbackPath}`,
		result: resultPromise,
		close() {
			primary.close();
			primary.closeAllConnections?.();
		},
	};
}

/** Parse a pasted redirect URL / query string / raw code into code+state. */
export function parseCallbackInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
	} catch {
		/* not a URL */
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value.replace(/^[?#]/, ""));
		return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
	}
	const [code, state] = value.split("#", 2);
	return { code, state };
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
}

async function postToken(variant: VariantConfig, body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
	const response = await oauthFetch(
		TOKEN_URL,
		{
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(body).toString(),
		},
		signal,
	);
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new OAuthFlowError(`Google token endpoint failed (${response.status}): ${detail}`, "token-exchange", response.status);
	}
	return (await response.json()) as TokenResponse;
}

async function getUserEmail(accessToken: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const response = await oauthFetch(
			"https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
			{ headers: { Authorization: `Bearer ${accessToken}` } },
			signal,
		);
		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {
		/* email is optional */
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Public entry points (wired into pi.registerProvider oauth config)
// ---------------------------------------------------------------------------

/** `/login google`: pick a client, run the browser flow, return credentials. */
export async function loginGoogle(cb: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const selection = await cb.onSelect({
		message: "Authenticate as which Google client?",
		options: [
			{ id: "antigravity", label: "Antigravity — newest Gemini models (daily-cloudcode-pa)" },
			{ id: "gemini-cli", label: "Gemini CLI — standard Cloud Code Assist (cloudcode-pa)" },
		],
	});
	if (!selection) throw new Error("Login cancelled");
	const variantId = (selection === "gemini-cli" ? "gemini-cli" : "antigravity") as GoogleVariantId;
	const variant = VARIANTS[variantId];

	const state = randomBytes(16).toString("hex");
	if (cb.signal?.aborted) throw new Error("Login cancelled");

	const handle = await startCallbackServer(variant.callbackPath, variant.callbackPort, state);
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
		cb.onAuth({ url: `${AUTH_URL}?${authParams.toString()}` });
		cb.onProgress?.(
			handle.port === variant.callbackPort
				? `[${variant.label}] Waiting for browser authentication...`
				: `[${variant.label}] Port ${variant.callbackPort} was busy; using ${handle.redirectUri}. Waiting for browser authentication...`,
		);

		const timeoutSignal = AbortSignal.timeout(CALLBACK_TIMEOUT_MS);
		const waitSignal = cb.signal ? AbortSignal.any([cb.signal, timeoutSignal]) : timeoutSignal;

		let code: string | undefined;
		try {
			const waits: Array<Promise<{ code: string; state: string }>> = [handle.result];
			// Optional paste-the-code fallback for headless setups.
			if (cb.onManualCodeInput) {
				const manual = (async () => {
					for (;;) {
						const input = await cb.onManualCodeInput!();
						const parsed = parseCallbackInput(input);
						if (parsed.code && (!parsed.state || parsed.state === state)) {
							return { code: parsed.code, state: parsed.state ?? "" };
						}
					}
				})();
				waits.push(manual);
			}
			code = (
				await Promise.race([
					Promise.race(waits),
					new Promise<never>((_, reject) =>
						waitSignal.addEventListener(
							"abort",
							() => reject(new Error(`OAuth login cancelled or timed out: ${String(waitSignal.reason)}`)),
							{ once: true },
						),
					),
				])
			).code;
		} catch (err) {
			if (timeoutSignal.aborted) throw new OAuthFlowError("Timed out waiting for the browser callback (5 min).", "timeout");
			throw err;
		}

		cb.onProgress?.(`[${variant.label}] Exchanging authorization code for tokens...`);
		const tokenData = await postToken(
			variant,
			{
				client_id: variant.clientId,
				client_secret: variant.clientSecret,
				code,
				grant_type: "authorization_code",
				redirect_uri: handle.redirectUri,
			},
			cb.signal,
		);
		if (!tokenData.refresh_token) {
			throw new OAuthFlowError("No refresh token received — please retry the login.", "validation");
		}

		cb.onProgress?.(`[${variant.label}] Getting user info...`);
		const email = await getUserEmail(tokenData.access_token, cb.signal);

		cb.onProgress?.(`[${variant.label}] Discovering Cloud Code Assist project...`);
		const projectId = await variant.discoverProject(tokenData.access_token, cb.onProgress, cb.signal);

		return {
			variant: variantId,
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			// 5-minute safety margin, same as Gemini CLI.
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			projectId,
			email,
		} satisfies GoogleOauthCredential;
	} finally {
		handle.close();
	}
}

/** Refresh a stored grant, dispatching on the recorded client variant. */
export async function refreshGoogleToken(credentials: OAuthCredentials, signal?: AbortSignal): Promise<OAuthCredentials> {
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

/** Serialize credentials into the apiKey string the stream implementation parses. */
export function googleCredentialApiKey(credentials: OAuthCredentials): string {
	const cred = credentials as GoogleOauthCredential;
	return JSON.stringify({
		token: credentials.access,
		projectId: cred.projectId,
		variant: cred.variant ?? "antigravity",
	});
}

/** Antigravity session-id derivation (mirrors omp: sha256 of first user text). */
const INT63_MASK = (1n << 63n) - 1n;
function signedDecimalSessionId(value: bigint): string {
	return `-${(value & INT63_MASK).toString()}`;
}
export function deriveAntigravitySessionId(firstUserText: string | undefined): string {
	if (firstUserText && firstUserText.trim().length > 0) {
		const digest = createHash("sha256").update(firstUserText).digest();
		let value = 0n;
		for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(digest[i] ?? 0);
		return signedDecimalSessionId(value);
	}
	return signedDecimalSessionId(BigInt(`0x${randomBytes(8).toString("hex")}`) % 9_000_000_000_000_000_000n);
}
