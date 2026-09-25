/**
 * The two Google login variants (Gemini CLI and Antigravity) plus the Antigravity
 * version probe and user agent they depend on.
 * Split out of `oauth.ts`.
 */
import { type GoogleVariantId, type VariantConfig, OAuthFlowError, type GeminiCliLoadPayload, type AntigravityLoadPayload } from "./oauth-types.ts";
import { oauthFetch, postJson, pollOperation, sleepUnlessAborted, isVpcScAffectedUser } from "./oauth-http.ts";

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

export const VARIANTS: Record<GoogleVariantId, VariantConfig> = {
	antigravity: antigravityVariant,
	"gemini-cli": geminiCliVariant,
};

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------
