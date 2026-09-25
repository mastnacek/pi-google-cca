/**
 * OAuth constants and the shared shapes: variant ids, the stored credential, the
 * flow error, the API payloads and the callback handle.
 * Split out of `oauth.ts`.
 */
import type { OAuthCredentials } from "@earendil-works/pi-ai";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export const CALLBACK_TIMEOUT_MS = 300_000;

export const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

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

export interface VariantConfig {
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

export class OAuthFlowError extends Error {
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

export interface GeminiCliLoadPayload {
	cloudaicompanionProject?: string;
	currentTier?: { id?: string };
	ineligibleTiers?: Array<{ reasonCode?: string; reasonMessage?: string }>;
}

export interface AntigravityLoadPayload {
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

export interface LongRunningOperation {
	name?: string;
	done?: boolean;
	error?: { code?: number; message?: string };
	response?: unknown;
}

export interface CallbackHandle {
	port: number;
	redirectUri: string;
	result: Promise<{ code: string; state: string }>;
	close(): void;
}

export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type?: string;
}
