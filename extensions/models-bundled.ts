// Static bundled Antigravity models and dynamic discovery.
import type { Api, Model } from "@earendil-works/pi-ai";
import { isClaudeModel } from "./model-catalog.ts";
import { ANTIGRAVITY_ENDPOINTS } from "./endpoints.ts";
import { antigravityUserAgent, ensureAntigravityVersion } from "./oauth.ts";
// ---------------------------------------------------------------------------
// Static bundled models & Dynamic discovery
// ---------------------------------------------------------------------------

export const BUNDLED_ANTIGRAVITY_MODELS = [
	// Gemini 3.x Flash
	{
		id: "gemini-3.7-flash",
		name: "Gemini 3.7 Flash",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.7-flash-preview",
		name: "Gemini 3.7 Flash (Preview)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.8-flash",
		name: "Gemini 3.8 Flash",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.6-flash",
		name: "Gemini 3.6 Flash",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini 3.5 Flash",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.5-flash-lite",
		name: "Gemini 3.5 Flash Lite",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	},
	{
		id: "gemini-3.1-flash-lite",
		name: "Gemini 3.1 Flash Lite",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	},
	{
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash (Preview)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	// Gemini 3.x Pro
	{
		id: "gemini-3.1-pro",
		name: "Gemini 3.1 Pro Preview",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro (Preview)",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	},
	{
		id: "gemini-3-pro",
		name: "Gemini 3 Pro",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	},
	// Gemini 2.5
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	},
	{
		id: "gemini-2.5-flash-lite",
		name: "Gemini 2.5 Flash Lite",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	},
	// Anthropic Claude on Antigravity
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 250_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-opus-4-6",
		name: "Claude Opus 4.6",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 250_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-opus-4-5",
		name: "Claude Opus 4.5",
		reasoning: true,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	// OpenAI GPT-OSS on Antigravity
	{
		id: "gpt-oss-120b",
		name: "GPT OSS 120B",
		reasoning: true,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
	},
	// Image models
	{
		id: "gemini-3-pro-image",
		name: "Nano Banana Pro",
		reasoning: false,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 2, output: 120, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
	},
	{
		id: "gemini-3.1-flash-image",
		name: "Nano Banana 2",
		reasoning: false,
		input: ["text", "image"] as ("text" | "image")[],
		cost: { input: 0.5, output: 60, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
];

export const DISCOVERY_DENYLIST = new Set(["chat_20706", "chat_23310"]);

export async function fetchAntigravityDynamicModels(
	accessToken: string,
	signal?: AbortSignal,
): Promise<typeof BUNDLED_ANTIGRAVITY_MODELS> {
	await ensureAntigravityVersion(signal);
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": antigravityUserAgent(),
	};

	for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
		try {
			const timeoutSignal = AbortSignal.timeout(10_000);
			const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
				method: "POST",
				headers,
				body: JSON.stringify({}),
				signal: combinedSignal,
			});

			if (!res.ok) continue;

			const data = (await res.json()) as {
				models?: Record<
					string,
					{
						displayName?: string;
						supportsImages?: boolean;
						supportsThinking?: boolean;
						maxTokens?: number;
						maxOutputTokens?: number;
						isInternal?: boolean;
					}
				>;
			};

			if (!data.models) continue;

			const discovered: typeof BUNDLED_ANTIGRAVITY_MODELS = [];
			const seenLogical = new Set<string>();

			for (const [rawId, info] of Object.entries(data.models)) {
				if (DISCOVERY_DENYLIST.has(rawId) || info.isInternal === true) continue;

				// Collapse effort suffix / thinking variants
				let logicalId = rawId;
				let logicalName = info.displayName || rawId;

				if (rawId.startsWith("gemini-") && rawId.includes("-flash")) {
					const m = /^(gemini-\d+(?:\.\d+)?-flash)(?:-(?:low|medium|high|tiered|extra-low))?$/.exec(rawId);
					if (m) {
						logicalId = m[1]!;
						logicalName = logicalId
							.split("-")
							.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
							.join(" ");
					}
				} else if (rawId.startsWith("gemini-3.1-pro")) {
					logicalId = "gemini-3.1-pro";
					logicalName = "Gemini 3.1 Pro";
				} else if (rawId === "gemini-pro-agent") {
					logicalId = "gemini-3.1-pro";
					logicalName = "Gemini 3.1 Pro";
				} else if (rawId.startsWith("gemini-3-pro")) {
					logicalId = "gemini-3-pro";
					logicalName = "Gemini 3 Pro";
				} else if (rawId.startsWith("claude-sonnet-4-6")) {
					logicalId = "claude-sonnet-4-6";
					logicalName = "Claude Sonnet 4.6 (Antigravity)";
				} else if (rawId.startsWith("claude-opus-4-6")) {
					logicalId = "claude-opus-4-6";
					logicalName = "Claude Opus 4.6 (Antigravity)";
				} else if (rawId.startsWith("claude-sonnet-4-5")) {
					logicalId = "claude-sonnet-4-5";
					logicalName = "Claude Sonnet 4.5 (Antigravity)";
				} else if (rawId.startsWith("claude-opus-4-5")) {
					logicalId = "claude-opus-4-5";
					logicalName = "Claude Opus 4.5 (Antigravity)";
				} else if (rawId.startsWith("gpt-oss-120b")) {
					logicalId = "gpt-oss-120b";
					logicalName = "GPT-OSS 120B (Antigravity)";
				}

				if (seenLogical.has(logicalId)) continue;
				seenLogical.add(logicalId);

				const isClaude = isClaudeModel(logicalId);
				const maxTokens = isClaude ? 64_000 : (info.maxOutputTokens ?? 65_536);
				const contextWindow = info.maxTokens ?? (isClaude ? 200_000 : 1_048_576);

				discovered.push({
					id: logicalId,
					name: logicalName,
					reasoning: info.supportsThinking ?? true,
					input: (info.supportsImages ?? true ? ["text", "image"] : ["text"]) as ("text" | "image")[],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					maxTokens,
				});
			}

			// Merge with bundled models to ensure canonical IDs are always present
			const result = [...discovered];
			for (const bundled of BUNDLED_ANTIGRAVITY_MODELS) {
				if (!seenLogical.has(bundled.id)) {
					result.push(bundled);
				}
			}
			return result;
		} catch {
			// Try next endpoint
		}
	}

	return BUNDLED_ANTIGRAVITY_MODELS;
}
