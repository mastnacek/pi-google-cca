/**
 * Pi extension: browser OAuth login for the built-in `google` and `google-antigravity`
 * providers, streaming via the Cloud Code Assist wire API instead of an AI Studio API key.
 *
 * Supports all Antigravity models: Gemini 3.x/2.5, Claude (Sonnet 4.6, Opus 4.6, Sonnet 4.5, Opus 4.5),
 * and GPT-OSS (120B), with automatic endpoint failover, thinking config, and quota tracking.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerGoogleQuotaCommand } from "./command.ts";
import { loadConfig, setConfigCwd } from "./config.ts";
import { ANTIGRAVITY_ENDPOINTS, ANTIGRAVITY_PRIMARY_ENDPOINT } from "./endpoints.ts";
import {
	BUNDLED_ANTIGRAVITY_MODELS,
	fetchAntigravityDynamicModels,
} from "./models-bundled.ts";
import {
	googleCredentialApiKey,
	loginGoogle,
	refreshGoogleToken,
} from "./oauth.ts";
import { getAntigravityQuota, invalidateQuotaCache } from "./quota.ts";
import { updateQuotaStatusline } from "./statusline.ts";
import { streamGoogleCca } from "./stream.ts";

// Public surface kept stable for existing consumers and tests.
export {
	ANTIGRAVITY_MODEL_ROUTING,
	ANTIGRAVITY_WIRE_PROFILES,
	antigravityWireModelId,
	type AntigravityModelWireProfile,
} from "./model-catalog.ts";
export { BUNDLED_ANTIGRAVITY_MODELS, fetchAntigravityDynamicModels } from "./models-bundled.ts";
export { streamGoogleCca } from "./stream.ts";

// ---------------------------------------------------------------------------
// Registration & Lifecycle
// ---------------------------------------------------------------------------

let quotaRefreshTimer: ReturnType<typeof setInterval> | null = null;

export default async function (pi: ExtensionAPI): Promise<void> {
	/** Unsubscribers from every `pi.on()`; drained on session_shutdown (AGENTS §5). */
	const unsubscribers: Array<() => void> = [];

	/** Retain a `pi.on()` return value; older engine typings declare it void. */
	const track = (result: unknown): void => {
		if (typeof result === "function") unsubscribers.push(result as () => void);
	};

	loadConfig();

	const oauthConfig = {
		name: "Google (Antigravity)",
		isSubscription: true,
		login: loginGoogle,
		refreshToken: refreshGoogleToken,
		getApiKey: googleCredentialApiKey,
	};

	const refreshModelsHandler = async (context: { signal?: AbortSignal }) => {
		try {
			const quota = await getAntigravityQuota(false, context.signal);
			void quota;
		} catch {
			// Ignore
		}
		return BUNDLED_ANTIGRAVITY_MODELS;
	};

	// Register built-in "google" provider
	pi.registerProvider("google", {
		name: "Google (Cloud Code Assist OAuth)",
		api: "google-generative-ai",
		baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
		streamSimple: streamGoogleCca,
		models: BUNDLED_ANTIGRAVITY_MODELS,
		refreshModels: refreshModelsHandler,
		oauth: oauthConfig,
	});

	// Also register "google-antigravity" provider
	pi.registerProvider("google-antigravity", {
		name: "Google Antigravity",
		api: "google-generative-ai",
		baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
		streamSimple: streamGoogleCca,
		models: BUNDLED_ANTIGRAVITY_MODELS,
		refreshModels: refreshModelsHandler,
		oauth: {
			...oauthConfig,
			name: "Google Antigravity",
		},
	});

	// Initialize statusline on session start and refresh every 3 minutes
	track(pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		// Point the config cascade at this session's project layer.
		setConfigCwd(ctx.cwd);
		await updateQuotaStatusline(ctx);
		if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
		quotaRefreshTimer = setInterval(() => {
			void updateQuotaStatusline(ctx, true);
		}, 180_000);
	}));

	// Refresh statusline after turn ends if Google provider was involved
	track(pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		if (ctx.model?.provider === "google" || ctx.model?.provider === "google-antigravity") {
			invalidateQuotaCache();
			await updateQuotaStatusline(ctx, true);
		}
	}));

	// React to model changes
	track(pi.on("model_select", async (event, ctx: ExtensionContext) => {
		if (event.model.provider === "google" || event.model.provider === "google-antigravity") {
			await updateQuotaStatusline(ctx);
		} else if (ctx.hasUI) {
			ctx.ui.setStatus("google-cca", undefined);
		}
	}));

	// Clean up background timer on session shutdown
	pi.on("session_shutdown", async () => {
		while (unsubscribers.length > 0) unsubscribers.pop()?.();
		if (quotaRefreshTimer) {
			clearInterval(quotaRefreshTimer);
			quotaRefreshTimer = null;
		}
	});

	// Register /google-quota command
	registerGoogleQuotaCommand(pi);
}
