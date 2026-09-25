/**
 * Google OAuth: the interactive login, token refresh and credential helpers.
 *
 * The supporting pieces live in sibling modules (types, HTTP helpers, the login
 * variants, the callback server); this module re-exports them so existing importers
 * keep working unchanged.
 */
import { createHash, randomBytes } from "node:crypto";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import { AUTH_URL, TOKEN_URL, CALLBACK_TIMEOUT_MS, type GoogleVariantId, type GoogleOauthCredential, type VariantConfig, OAuthFlowError, type TokenResponse } from "./oauth-types.ts";
import { oauthFetch } from "./oauth-http.ts";
import { VARIANTS } from "./oauth-variants.ts";
import { startCallbackServer, parseCallbackInput } from "./oauth-callback.ts";

// Re-exported so every existing importer keeps working unchanged.
export { type GoogleVariantId, type GoogleOauthCredential } from "./oauth-types.ts";
export { DEFAULT_ANTIGRAVITY_VERSION, getAntigravityVersion, parseAntigravityManifestVersion, ensureAntigravityVersion, antigravityUserAgent, ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA } from "./oauth-variants.ts";
export { parseCallbackInput } from "./oauth-callback.ts";

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
