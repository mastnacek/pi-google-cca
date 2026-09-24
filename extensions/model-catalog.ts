// Antigravity model catalog: wire profiles, routing table and id mapping.
//
// Pure data + predicates; no I/O (so it is cheap to import anywhere).
// ---------------------------------------------------------------------------
// Antigravity wire profiles & routing
// ---------------------------------------------------------------------------

export interface AntigravityModelWireProfile {
	modelEnum?: string;
	maxOutputTokens: number;
}

export const ANTIGRAVITY_WIRE_PROFILES: Record<string, AntigravityModelWireProfile> = {
	"gemini-3.5-flash-extra-low": {
		modelEnum: "MODEL_PLACEHOLDER_M187",
		maxOutputTokens: 65_536,
	},
	"gemini-3.5-flash-low": {
		modelEnum: "MODEL_PLACEHOLDER_M20",
		maxOutputTokens: 65_536,
	},
	"gemini-3-flash-agent": {
		modelEnum: "MODEL_PLACEHOLDER_M84",
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
	"gemini-3.6-flash-tiered": {
		modelEnum: "MODEL_PLACEHOLDER_M196",
		maxOutputTokens: 65_536,
	},
	"gemini-3.7-flash-tiered": {
		modelEnum: "MODEL_PLACEHOLDER_M301",
		maxOutputTokens: 65_536,
	},
	"gemini-3.7-flash-low": {
		modelEnum: "MODEL_PLACEHOLDER_M301",
		maxOutputTokens: 65_536,
	},
	"gemini-3.7-flash-medium": {
		modelEnum: "MODEL_PLACEHOLDER_M301",
		maxOutputTokens: 65_536,
	},
	"gemini-3.7-flash-high": {
		modelEnum: "MODEL_PLACEHOLDER_M301",
		maxOutputTokens: 65_536,
	},
	"gemini-3.8-flash-tiered": {
		modelEnum: "MODEL_PLACEHOLDER_M322",
		maxOutputTokens: 65_536,
	},
	"gemini-3.8-flash-low": {
		modelEnum: "MODEL_PLACEHOLDER_M322",
		maxOutputTokens: 65_536,
	},
	"gemini-3.8-flash-medium": {
		modelEnum: "MODEL_PLACEHOLDER_M322",
		maxOutputTokens: 65_536,
	},
	"gemini-3.8-flash-high": {
		modelEnum: "MODEL_PLACEHOLDER_M322",
		maxOutputTokens: 65_536,
	},
	"gemini-3.5-flash-lite": {
		modelEnum: "MODEL_PLACEHOLDER_M198",
		maxOutputTokens: 65_535,
	},
	"gemini-3.1-flash-lite": {
		modelEnum: "MODEL_PLACEHOLDER_M50",
		maxOutputTokens: 65_535,
	},
	"gemini-3.1-pro-low": {
		modelEnum: "MODEL_PLACEHOLDER_M36",
		maxOutputTokens: 65_535,
	},
	"gemini-3.1-pro-high": {
		modelEnum: "MODEL_PLACEHOLDER_M37",
		maxOutputTokens: 65_535,
	},
	"gemini-pro-agent": {
		modelEnum: "MODEL_PLACEHOLDER_M16",
		maxOutputTokens: 65_535,
	},
	"gemini-2.5-flash": {
		modelEnum: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
		maxOutputTokens: 65_535,
	},
	"gemini-2.5-flash-lite": {
		modelEnum: "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE",
		maxOutputTokens: 65_535,
	},
	"gemini-2.5-flash-thinking": {
		modelEnum: "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
		maxOutputTokens: 65_535,
	},
	"gemini-2.5-pro": {
		modelEnum: "MODEL_GOOGLE_GEMINI_2_5_PRO",
		maxOutputTokens: 65_535,
	},
	"claude-sonnet-4-6": {
		modelEnum: "MODEL_PLACEHOLDER_M35",
		maxOutputTokens: 64_000,
	},
	"claude-opus-4-6-thinking": {
		modelEnum: "MODEL_PLACEHOLDER_M26",
		maxOutputTokens: 64_000,
	},
	"claude-sonnet-4-5": {
		maxOutputTokens: 64_000,
	},
	"claude-sonnet-4-5-thinking": {
		maxOutputTokens: 64_000,
	},
	"claude-opus-4-5": {
		maxOutputTokens: 64_000,
	},
	"claude-opus-4-5-thinking": {
		maxOutputTokens: 64_000,
	},
	"gpt-oss-120b-medium": {
		modelEnum: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
		maxOutputTokens: 65_536,
	},
};

export const ANTIGRAVITY_MODEL_ROUTING: Record<string, Record<string, string>> = {
	"gemini-3.7-flash": {
		off: "gemini-3.7-flash-tiered",
		minimal: "gemini-3.7-flash-tiered",
		low: "gemini-3.7-flash-tiered",
		medium: "gemini-3.7-flash-tiered",
		high: "gemini-3.7-flash-tiered",
	},
	"gemini-3.7-flash-preview": {
		off: "gemini-3.7-flash-tiered",
		minimal: "gemini-3.7-flash-tiered",
		low: "gemini-3.7-flash-tiered",
		medium: "gemini-3.7-flash-tiered",
		high: "gemini-3.7-flash-tiered",
	},
	"gemini-3.8-flash": {
		off: "gemini-3.8-flash-tiered",
		minimal: "gemini-3.8-flash-tiered",
		low: "gemini-3.8-flash-tiered",
		medium: "gemini-3.8-flash-tiered",
		high: "gemini-3.8-flash-tiered",
	},
	"gemini-3.8-flash-preview": {
		off: "gemini-3.8-flash-tiered",
		minimal: "gemini-3.8-flash-tiered",
		low: "gemini-3.8-flash-tiered",
		medium: "gemini-3.8-flash-tiered",
		high: "gemini-3.8-flash-tiered",
	},
	"gemini-3.6-flash": {
		off: "gemini-3.6-flash-low",
		minimal: "gemini-3.6-flash-low",
		low: "gemini-3.6-flash-low",
		medium: "gemini-3.6-flash-medium",
		high: "gemini-3.6-flash-high",
	},
	"gemini-3.6-flash-preview": {
		off: "gemini-3.6-flash-low",
		minimal: "gemini-3.6-flash-low",
		low: "gemini-3.6-flash-low",
		medium: "gemini-3.6-flash-medium",
		high: "gemini-3.6-flash-high",
	},
	"gemini-3.5-flash": {
		off: "gemini-3.7-flash-tiered",
		minimal: "gemini-3.7-flash-tiered",
		low: "gemini-3.7-flash-tiered",
		medium: "gemini-3.7-flash-tiered",
		high: "gemini-3.7-flash-tiered",
	},
	"gemini-3.5-flash-lite": {
		off: "gemini-3.5-flash-lite",
		minimal: "gemini-3.5-flash-lite",
		low: "gemini-3.5-flash-lite",
		medium: "gemini-3.5-flash-lite",
		high: "gemini-3.5-flash-lite",
	},
	"gemini-3-flash": {
		off: "gemini-3.7-flash-tiered",
		minimal: "gemini-3.7-flash-tiered",
		low: "gemini-3.7-flash-tiered",
		medium: "gemini-3.7-flash-tiered",
		high: "gemini-3.7-flash-tiered",
	},
	"gemini-3-flash-preview": {
		off: "gemini-3.7-flash-tiered",
		minimal: "gemini-3.7-flash-tiered",
		low: "gemini-3.7-flash-tiered",
		medium: "gemini-3.7-flash-tiered",
		high: "gemini-3.7-flash-tiered",
	},
	"gemini-flash-latest": {
		off: "gemini-3.7-flash-tiered",
		minimal: "gemini-3.7-flash-tiered",
		low: "gemini-3.7-flash-tiered",
		medium: "gemini-3.7-flash-tiered",
		high: "gemini-3.7-flash-tiered",
	},
	"gemini-flash-lite-latest": {
		off: "gemini-3.5-flash-lite",
		minimal: "gemini-3.5-flash-lite",
		low: "gemini-3.5-flash-lite",
		medium: "gemini-3.5-flash-lite",
		high: "gemini-3.5-flash-lite",
	},
	"gemini-3.1-flash-lite": {
		off: "gemini-3.1-flash-lite",
		minimal: "gemini-3.1-flash-lite",
		low: "gemini-3.1-flash-lite",
		medium: "gemini-3.1-flash-lite",
		high: "gemini-3.1-flash-lite",
	},
	"gemini-2.5-flash-lite": {
		off: "gemini-2.5-flash-lite",
		minimal: "gemini-2.5-flash-lite",
		low: "gemini-2.5-flash-lite",
		medium: "gemini-2.5-flash-lite",
		high: "gemini-2.5-flash-lite",
	},
	"gemini-3.1-pro": {
		off: "gemini-3.1-pro-low",
		minimal: "gemini-3.1-pro-low",
		low: "gemini-3.1-pro-low",
		high: "gemini-pro-agent",
	},
	"gemini-3.1-pro-preview": {
		off: "gemini-3.1-pro-low",
		minimal: "gemini-3.1-pro-low",
		low: "gemini-3.1-pro-low",
		high: "gemini-pro-agent",
	},
	"gemini-3.1-pro-preview-customtools": {
		off: "gemini-3.1-pro-low",
		minimal: "gemini-3.1-pro-low",
		low: "gemini-3.1-pro-low",
		high: "gemini-pro-agent",
	},
	"gemini-3-pro": {
		off: "gemini-3.1-pro-low",
		minimal: "gemini-3.1-pro-low",
		low: "gemini-3.1-pro-low",
		high: "gemini-pro-agent",
	},
	"claude-sonnet-4-6": {
		off: "claude-sonnet-4-6",
		minimal: "claude-sonnet-4-6",
		low: "claude-sonnet-4-6",
		medium: "claude-sonnet-4-6",
		high: "claude-sonnet-4-6",
	},
	"claude-opus-4-6": {
		off: "claude-opus-4-6-thinking",
		minimal: "claude-opus-4-6-thinking",
		low: "claude-opus-4-6-thinking",
		medium: "claude-opus-4-6-thinking",
		high: "claude-opus-4-6-thinking",
	},
	"claude-sonnet-4-5": {
		off: "claude-sonnet-4-5",
		minimal: "claude-sonnet-4-5-thinking",
		low: "claude-sonnet-4-5-thinking",
		medium: "claude-sonnet-4-5-thinking",
		high: "claude-sonnet-4-5-thinking",
	},
	"claude-opus-4-5": {
		off: "claude-opus-4-5",
		minimal: "claude-opus-4-5-thinking",
		low: "claude-opus-4-5-thinking",
		medium: "claude-opus-4-5-thinking",
		high: "claude-opus-4-5-thinking",
	},
	"gpt-oss-120b": {
		off: "gpt-oss-120b-medium",
		minimal: "gpt-oss-120b-medium",
		low: "gpt-oss-120b-medium",
		medium: "gpt-oss-120b-medium",
		high: "gpt-oss-120b-medium",
	},
};

export function isClaudeModel(id: string): boolean {
	return id.toLowerCase().startsWith("claude-");
}

export function isGptModel(id: string): boolean {
	return id.toLowerCase().startsWith("gpt-");
}

export function isGemini3Pro(id: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(id.toLowerCase());
}

export function isGemini3Flash(id: string): boolean {
	const lower = id.toLowerCase();
	return (
		/gemini-3(?:\.\d+)?-flash/.test(lower) ||
		lower === "gemini-flash-latest" ||
		lower === "gemini-flash-lite-latest"
	);
}

export function antigravityWireModelId(modelId: string, effort: string | undefined): string {
	const routing = ANTIGRAVITY_MODEL_ROUTING[modelId];
	if (routing) {
		return routing[effort ?? "off"] ?? Object.values(routing)[0]!;
	}
	// Generic flash template routing for future gemini-{rev}-flash
	const flashMatch = /^gemini-(\d+(?:\.\d+)?)-flash/.exec(modelId);
	if (flashMatch) {
		const rev = flashMatch[1];
		if (rev === "3.6") {
			if (effort === "high") return `gemini-3.6-flash-high`;
			if (effort === "medium") return `gemini-3.6-flash-medium`;
			return `gemini-3.6-flash-low`;
		}
		return `gemini-${rev}-flash-tiered`;
	}
	return modelId;
}
