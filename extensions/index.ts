/**
 * Pi extension: browser OAuth login for the built-in `google` and `google-antigravity`
 * providers, streaming via the Cloud Code Assist wire API instead of an AI Studio API key.
 *
 * Supports all Antigravity models: Gemini 3.x/2.5, Claude (Sonnet 4.6, Opus 4.6, Sonnet 4.5, Opus 4.5),
 * and GPT-OSS (120B), with automatic endpoint failover, thinking config, and quota tracking.
 */
import { randomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	calculateCost,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	convertMessages,
	convertTools,
	isThinkingPart,
	type ModelWire,
	retainThoughtSignature,
	sanitizeSurrogates,
} from "./google-wire.ts";
import {
	antigravityUserAgent,
	deriveAntigravitySessionId,
	ensureAntigravityVersion,
	googleCredentialApiKey,
	type GoogleVariantId,
	loginGoogle,
	refreshGoogleToken,
} from "./oauth.ts";
import {
	formatQuotaDetailBanner,
	formatQuotaStatusline,
	getAntigravityQuota,
	invalidateQuotaCache,
} from "./quota.ts";

const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_PRIMARY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_ENDPOINTS = [
	ANTIGRAVITY_PRIMARY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
];

const REQUEST_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

function geminiCliUserAgent(modelId: string): string {
	const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.46.0";
	const platform = process.platform === "win32" ? "win32" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

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

function isClaudeModel(id: string): boolean {
	return id.toLowerCase().startsWith("claude-");
}

function isGptModel(id: string): boolean {
	return id.toLowerCase().startsWith("gpt-");
}

function isGemini3Pro(id: string): boolean {
	return /gemini-3(?:\.\d+)?-pro/.test(id.toLowerCase());
}

function isGemini3Flash(id: string): boolean {
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

// ---------------------------------------------------------------------------
// Thinking config
// ---------------------------------------------------------------------------

interface ThinkingConfig {
	includeThoughts: boolean;
	thinkingLevel?: "LOW" | "MEDIUM" | "HIGH" | "MINIMAL";
	thinkingBudget?: number;
}

function thinkingConfigFor(
	model: Model<Api>,
	options: SimpleStreamOptions | undefined,
): ThinkingConfig | undefined {
	const reasoning = options?.reasoning;
	const isClaude = isClaudeModel(model.id);
	const isGpt = isGptModel(model.id);

	if (!reasoning) {
		if (isGemini3Flash(model.id) || isGemini3Pro(model.id)) {
			return { includeThoughts: false, thinkingLevel: "LOW" };
		}
		if (isClaude || isGpt || model.id.includes("gemini-2.5")) {
			return { includeThoughts: false, thinkingBudget: 0 };
		}
		return undefined;
	}

	if (isClaude || isGpt) {
		const budget =
			typeof reasoning === "number"
				? reasoning
				: reasoning === "high"
					? 10_000
					: reasoning === "medium"
						? 4_000
						: 1_000;
		return { includeThoughts: true, thinkingBudget: budget };
	}

	if (isGemini3Pro(model.id)) {
		if (model.id.includes("3.1")) {
			const budget = reasoning === "high" ? 10_001 : 1_001;
			return { includeThoughts: true, thinkingBudget: budget };
		}
		return { includeThoughts: true, thinkingLevel: reasoning === "high" ? "HIGH" : "LOW" };
	}

	if (isGemini3Flash(model.id)) {
		if (model.id.includes("3.5") || model.id === "gemini-3-flash") {
			const budget =
				reasoning === "high"
					? 10_000
					: reasoning === "medium"
						? 4_000
						: 1_000;
			return { includeThoughts: true, thinkingBudget: budget };
		}
		// Gemini 3.6+ Flash: uses thinkingLevel (MINIMAL is rejected upstream, mapped to LOW)
		const level =
			reasoning === "high"
				? "HIGH"
				: reasoning === "medium"
					? "MEDIUM"
					: "LOW";
		return { includeThoughts: true, thinkingLevel: level };
	}

	if (reasoning !== undefined) {
		const budget =
			typeof reasoning === "number"
				? reasoning
				: reasoning === "high"
					? 8_192
					: reasoning === "medium"
						? 4_096
						: 2_048;
		return { includeThoughts: true, thinkingBudget: budget };
	}

	return undefined;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

interface CcaRequest {
	project: string;
	model: string;
	request: {
		contents: unknown[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			topP?: number;
			topK?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: { functionDeclarations: unknown[] }[];
		toolConfig?: {
			functionCallingConfig: {
				mode: "AUTO" | "ANY" | "NONE" | "VALIDATED";
				allowedFunctionNames?: string[];
			};
		};
		labels?: Record<string, string>;
	};
	userAgent?: string;
	requestType?: string;
	requestId?: string;
}

const antigravitySession: {
	agentId?: string;
	trajectoryId?: string;
	sessionId?: string;
	stepIndex?: number;
	lastExecutionId?: string;
	lastGoodEndpoint?: string;
} = {};

function firstUserText(context: Context): string | undefined {
	for (const message of context.messages) {
		if (message.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		if (Array.isArray(message.content)) {
			const first = message.content.find((p) => p.type === "text");
			if (first && "text" in first) return first.text as string;
		}
	}
	return undefined;
}

function buildCcaRequest(
	model: Model<Api>,
	context: Context,
	projectId: string,
	options: SimpleStreamOptions | undefined,
	isAntigravity: boolean,
): CcaRequest {
	const wireModel: ModelWire = {
		id: model.id,
		provider: model.provider,
		api: model.api,
		input: model.input,
	};
	const contents = convertMessages(wireModel, context);
	const generationConfig: CcaRequest["request"]["generationConfig"] = {};

	if (options?.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options?.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const thinking = thinkingConfigFor(model, options);
	if (thinking) {
		generationConfig.thinkingConfig = thinking;
	}

	const request: CcaRequest["request"] = { contents };

	if (context.systemPrompt && context.systemPrompt.trim().length > 0) {
		// Antigravity tags systemInstruction with role "user"
		request.systemInstruction = {
			...(isAntigravity ? { role: "user" } : {}),
			parts: [{ text: context.systemPrompt }],
		};
	}

	const wireModelId = isAntigravity
		? antigravityWireModelId(model.id, typeof options?.reasoning === "string" ? options.reasoning : undefined)
		: model.id;
	const isClaude = isClaudeModel(model.id) || isClaudeModel(wireModelId);

	if (context.tools && context.tools.length > 0) {
		request.tools = convertTools(context.tools);
		if (isAntigravity) {
			request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
		}
	}

	// Claude on Antigravity always forces VALIDATED tool mode, even with no tools declared
	if (isAntigravity && isClaude) {
		request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
	}

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	if (!isAntigravity) {
		return { project: projectId, model: model.id, request };
	}

	// Antigravity envelope: effort-routed wire id, fixed output cap, sessionId, structured requestId, labels
	const profile = ANTIGRAVITY_WIRE_PROFILES[wireModelId];
	if (profile) {
		generationConfig.maxOutputTokens = profile.maxOutputTokens;
	} else if (isClaude) {
		generationConfig.maxOutputTokens = 64_000;
	}

	const state = antigravitySession;
	state.agentId ??= randomUUID();
	state.trajectoryId ??= randomUUID();
	state.sessionId ??= deriveAntigravitySessionId(firstUserText(context));
	state.stepIndex = (state.stepIndex ?? 1) + 1;

	const requestId = `agent/${state.agentId}/${Date.now()}/${state.trajectoryId}/${state.stepIndex}`;
	const labels: Record<string, string> = {};
	if (state.lastExecutionId) labels.last_execution_id = state.lastExecutionId;
	labels.last_step_index = String((state.stepIndex ?? 2) - 1);
	if (profile?.modelEnum !== undefined) labels.model_enum = profile.modelEnum;
	labels.trajectory_id = state.trajectoryId;
	labels.used_claude = isClaude ? "true" : "false";
	labels.used_claude_conservative = isClaude ? "true" : "false";

	request.labels = labels;
	request.sessionId = state.sessionId;

	return {
		project: projectId,
		requestId,
		request,
		model: wireModelId,
		userAgent: "antigravity",
		requestType: "agent",
	};
}

// ---------------------------------------------------------------------------
// Response streaming & Planning leak guard
// ---------------------------------------------------------------------------

interface CcaResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					thought?: boolean;
					thoughtSignature?: string;
					functionCall?: { name: string; args: Record<string, unknown>; id?: string };
				}>;
			};
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		responseId?: string;
		promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
	};
	error?: { code?: number; message?: string; status?: string };
}

async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.startsWith("data:")) {
					yield trimmed.slice(5).trim();
				}
			}
		}
		if (buffer.trim().startsWith("data:")) {
			yield buffer.trim().slice(5).trim();
		}
	} finally {
		reader.releaseLock();
	}
}

function isPlanningLeakPrefix(text: string): boolean {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{")) return false;
	const afterBrace = trimmed.slice(1).trimStart();
	if (afterBrace === "") return trimmed.length <= 100;
	if (afterBrace[0] !== '"') return false;
	const nextQuoteIndex = afterBrace.indexOf('"', 1);
	if (nextQuoteIndex === -1) {
		const keyPrefix = afterBrace.slice(1);
		return "thought".startsWith(keyPrefix) && trimmed.length <= 100;
	}
	const key = afterBrace.slice(1, nextQuoteIndex);
	if (key !== "thought") return false;
	const afterKey = afterBrace.slice(nextQuoteIndex + 1).trimStart();
	if (afterKey === "") return trimmed.length <= 100;
	return afterKey[0] === ":";
}

function splitLeadingJsonObject(
	text: string,
	ignoreQuotes: boolean,
): { jsonText: string; rest: string } | undefined {
	const prefixLength = text.length - text.trimStart().length;
	const trimmed = text.slice(prefixLength);
	if (!trimmed.startsWith("{")) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (!ignoreQuotes) {
			if (inString) {
				if (escaped) {
					escaped = false;
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					continue;
				}
				if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') {
				inString = true;
				continue;
			}
		}
		if (ch === "{") {
			depth++;
			continue;
		}
		if (ch !== "}") continue;
		depth--;
		if (depth === 0) {
			return {
				jsonText: trimmed.slice(0, i + 1),
				rest: trimmed.slice(i + 1),
			};
		}
	}
	return undefined;
}

function isPlanningLeakObject(parsed: unknown, toolNames: Set<string>): boolean {
	if (!parsed || typeof parsed !== "object") return false;
	const rec = parsed as Record<string, unknown>;
	const hasThought = typeof rec.thought === "string";
	const isToolCall = typeof rec.call === "string" && toolNames.has(rec.call);
	const hasToolSig =
		"_i" in rec ||
		"paths" in rec ||
		"command" in rec ||
		("path" in rec && "content" in rec);
	return hasThought || isToolCall || hasToolSig;
}

type BufferedPlanning =
	| { kind: "incomplete" }
	| { kind: "plain"; visibleText: string }
	| { kind: "leak"; visibleText: string };

function consumePlanningBuffer(
	text: string,
	toolNames: Set<string>,
	isFinal = false,
): BufferedPlanning {
	if (!isPlanningLeakPrefix(text)) {
		return { kind: "plain", visibleText: text };
	}

	let leading = splitLeadingJsonObject(text, false) ?? splitLeadingJsonObject(text, true);

	if (!leading) {
		if (isFinal) {
			const trimmed = text.trim();
			const hasThought = trimmed.includes('"thought"');
			const hasTool = Array.from(toolNames).some((n) => trimmed.includes(`"${n}"`));
			const hasSig =
				trimmed.includes('"_i"') ||
				trimmed.includes('"paths"') ||
				trimmed.includes('"command"') ||
				(trimmed.includes('"path"') && trimmed.includes('"content"'));
			if (hasThought || hasTool || hasSig) {
				return { kind: "leak", visibleText: "" };
			}
			return { kind: "plain", visibleText: text };
		}
		return { kind: "incomplete" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(leading.jsonText);
	} catch {
		const isLeak =
			leading.jsonText.includes('"thought"') ||
			Array.from(toolNames).some((n) => leading.jsonText.includes(`"${n}"`));
		return isLeak
			? { kind: "leak", visibleText: leading.rest }
			: { kind: "plain", visibleText: text };
	}

	return isPlanningLeakObject(parsed, toolNames)
		? { kind: "leak", visibleText: leading.rest }
		: { kind: "plain", visibleText: text };
}

let toolCallCounter = 0;

interface ParsedCredential {
	token: string;
	projectId: string;
	variant: GoogleVariantId;
}

function parseStoredCredential(apiKey: string | undefined): ParsedCredential {
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

function isRetriableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function isRetriableTransportError(err: unknown): boolean {
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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

async function doFetchWithRetry(
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

export function streamGoogleCca(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const credential = parseStoredCredential(options?.apiKey);
			const isAntigravity = credential.variant === "antigravity";
			await ensureAntigravityVersion(options?.signal);

			let endpoints = isAntigravity
				? (antigravitySession.lastGoodEndpoint
						? [antigravitySession.lastGoodEndpoint, ...ANTIGRAVITY_ENDPOINTS.filter((e) => e !== antigravitySession.lastGoodEndpoint)]
						: ANTIGRAVITY_ENDPOINTS)
				: [GEMINI_CLI_ENDPOINT];

			let requestPayload: unknown = buildCcaRequest(
				model,
				context,
				credential.projectId,
				options,
				isAntigravity,
			);

			if (options?.onPayload) {
				const replacement = await options.onPayload(requestPayload, model);
				if (replacement !== undefined) {
					requestPayload = replacement;
				}
			}

			const body = JSON.stringify(requestPayload);
			const isClaude = isClaudeModel(model.id);

			const headers: Record<string, string> = {
				Authorization: `Bearer ${credential.token}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...(isAntigravity
					? { "User-Agent": antigravityUserAgent() }
					: {
							"User-Agent": geminiCliUserAgent(model.id),
							"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
						}),
				...(isAntigravity && isClaude && options?.reasoning
					? { "anthropic-beta": "interleaved-thinking-2025-05-14" }
					: {}),
				...(options?.headers ?? {}),
			};

			const toolNames = new Set(context.tools?.map((t) => t.name) ?? []);
			const isLeakModel = model.id.includes("flash");
			let started = false;
			let firstTokenTime: number | undefined;

			const ensureStarted = () => {
				if (!started) {
					if (!firstTokenTime) firstTokenTime = performance.now();
					stream.push({ type: "start", partial: output });
					started = true;
				}
			};

			const resetOutput = () => {
				output.content = [];
				output.usage = {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				};
				output.stopReason = "pending";
				output.errorMessage = undefined;
			};

			/** Consume one SSE response into `output`. Returns true when content arrived. */
			const consumeResponse = async (response: Response): Promise<boolean> => {
				if (!response.body) throw new Error("Cloud Code Assist: empty response body");

				let currentBlock:
					| { type: "text"; text: string; textSignature?: string }
					| { type: "thinking"; thinking: string; thinkingSignature?: string }
					| null = null;
				const blocks = output.content;
				const blockIndex = () => blocks.length - 1;

				let isBuffering = false;
				let textBuffer = "";
				let bufferedSignature: string | undefined;
				let sawContent = false;
				let lastResponseId: string | undefined;

				const endCurrentBlock = () => {
					if (!currentBlock) return;
					if (currentBlock.type === "text") {
						stream.push({
							type: "text_end",
							contentIndex: blockIndex(),
							content: currentBlock.text,
							partial: output,
						});
					} else {
						stream.push({
							type: "thinking_end",
							contentIndex: blockIndex(),
							content: currentBlock.thinking,
							partial: output,
						});
					}
					currentBlock = null;
				};

				const startTextBlock = () => {
					if (currentBlock?.type !== "text") {
						endCurrentBlock();
						currentBlock = { type: "text", text: "" };
						blocks.push(currentBlock);
						ensureStarted();
						stream.push({
							type: "text_start",
							contentIndex: blockIndex(),
							partial: output,
						});
					}
					return currentBlock;
				};

				const startThinkingBlock = () => {
					if (currentBlock?.type !== "thinking") {
						endCurrentBlock();
						currentBlock = {
							type: "thinking",
							thinking: "",
							thinkingSignature: undefined,
						};
						blocks.push(currentBlock);
						ensureStarted();
						stream.push({
							type: "thinking_start",
							contentIndex: blockIndex(),
							partial: output,
						});
					}
					return currentBlock;
				};

				const emitText = (delta: string, signature?: string) => {
					if (!delta) return;
					const block = startTextBlock();
					block.text += delta;
					block.textSignature = retainThoughtSignature(block.textSignature, signature);
					stream.push({
						type: "text_delta",
						contentIndex: blockIndex(),
						delta,
						partial: output,
					});
				};

				const flushLeakBuffer = () => {
					if (!isBuffering) return;
					const buffered = consumePlanningBuffer(textBuffer, toolNames, true);
					if (buffered.kind !== "incomplete") {
						emitText(buffered.visibleText, bufferedSignature);
					}
					isBuffering = false;
					textBuffer = "";
					bufferedSignature = undefined;
				};

				for await (const data of readSseData(response.body)) {
					let chunk: CcaResponseChunk;
					try {
						chunk = JSON.parse(data) as CcaResponseChunk;
					} catch {
						continue;
					}

					if (chunk.error) {
						const detail = chunk.error.message || chunk.error.status || "unknown error";
						throw new Error(`Cloud Code Assist stream error: ${detail}`);
					}
					const responseData = chunk.response;
					if (!responseData) continue;
					if (responseData.responseId) lastResponseId = responseData.responseId;

					if (!responseData.candidates?.length && responseData.promptFeedback?.blockReason) {
						const detail = responseData.promptFeedback.blockReasonMessage;
						throw new Error(
							`Request blocked by Google (${responseData.promptFeedback.blockReason})${detail ? `: ${detail}` : ""}`,
						);
					}

					const candidate = responseData.candidates?.[0];
					if (candidate?.content?.parts) {
						for (const part of candidate.content.parts) {
							if (part.text !== undefined && part.text !== "") {
								sawContent = true;
								if (isThinkingPart(part)) {
									flushLeakBuffer();
									const block = startThinkingBlock();
									block.thinking += part.text;
									block.thinkingSignature = retainThoughtSignature(
										block.thinkingSignature,
										part.thoughtSignature,
									);
									stream.push({
										type: "thinking_delta",
										contentIndex: blockIndex(),
										delta: part.text,
										partial: output,
									});
								} else if (isLeakModel && (isBuffering || part.text.trimStart().startsWith("{"))) {
									isBuffering = true;
									textBuffer += part.text;
									bufferedSignature = retainThoughtSignature(
										bufferedSignature,
										part.thoughtSignature,
									);
									const buffered = consumePlanningBuffer(textBuffer, toolNames);
									if (buffered.kind !== "incomplete") {
										isBuffering = false;
										textBuffer = "";
										const sig = bufferedSignature;
										bufferedSignature = undefined;
										emitText(buffered.visibleText, sig);
									}
								} else {
									emitText(part.text, part.thoughtSignature);
								}
							} else if (part.text === "" && part.thoughtSignature && !part.functionCall) {
								if (currentBlock?.type === "thinking") {
									currentBlock.thinkingSignature = retainThoughtSignature(
										currentBlock.thinkingSignature,
										part.thoughtSignature,
									);
								} else if (currentBlock?.type === "text") {
									currentBlock.textSignature = retainThoughtSignature(
										currentBlock.textSignature,
										part.thoughtSignature,
									);
								}
							}

							if (part.functionCall) {
								flushLeakBuffer();
								endCurrentBlock();
								sawContent = true;
								const providedId = part.functionCall.id;
								const needsNewId =
									!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
								const toolCallId = needsNewId
									? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
									: providedId;
								const toolCall = {
									type: "toolCall" as const,
									id: toolCallId,
									name: part.functionCall.name || "",
									arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
									...(part.thoughtSignature && {
										thoughtSignature: part.thoughtSignature,
									}),
								};
								blocks.push(toolCall);
								ensureStarted();
								stream.push({
									type: "toolcall_start",
									contentIndex: blockIndex(),
									partial: output,
								});
								stream.push({
									type: "toolcall_delta",
									contentIndex: blockIndex(),
									delta: JSON.stringify(toolCall.arguments),
									partial: output,
								});
								stream.push({
									type: "toolcall_end",
									contentIndex: blockIndex(),
									toolCall,
									partial: output,
								});
							}
						}
					}

					if (candidate?.finishReason) {
						flushLeakBuffer();
						endCurrentBlock();
						if (candidate.finishReason === "STOP") {
							output.stopReason = output.content.some((b) => b.type === "toolCall")
								? "toolUse"
								: "stop";
						} else if (candidate.finishReason === "MAX_TOKENS") {
							output.stopReason = "length";
						} else {
							output.stopReason = "error";
							output.errorMessage = `Generation failed with finish reason: ${candidate.finishReason}`;
						}
					}

					if (responseData.usageMetadata) {
						const meta = responseData.usageMetadata;
						const inputTokens = meta.promptTokenCount ?? 0;
						const outputTokens = meta.candidatesTokenCount ?? 0;
						const cacheRead = meta.cachedContentTokenCount ?? 0;
						output.usage = {
							input: inputTokens,
							output: outputTokens,
							cacheRead,
							cacheWrite: 0,
							totalTokens: meta.totalTokenCount ?? inputTokens + outputTokens,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						};
						calculateCost(model, output.usage);
					}
				}

				flushLeakBuffer();
				endCurrentBlock();
				if (isAntigravity && lastResponseId) {
					antigravitySession.lastExecutionId = lastResponseId;
				}
				return sawContent;
			};

			// Endpoint failover (antigravity: primary → sandbox)
			const MAX_EMPTY_RETRIES = 2;
			let succeeded = false;

			for (let endpointIndex = 0; endpointIndex < endpoints.length && !succeeded; endpointIndex++) {
				const endpoint = endpoints[endpointIndex]!;
				const isLastEndpoint = endpointIndex === endpoints.length - 1;

				for (let attempt = 0; attempt <= MAX_EMPTY_RETRIES; attempt++) {
					if (options?.signal?.aborted) throw new Error("Request was aborted");

					let response: Response;
					try {
						response = await doFetchWithRetry(
							`${endpoint}/v1internal:streamGenerateContent?alt=sse`,
							{ method: "POST", headers, body },
							options,
						);
					} catch (err) {
						if (options?.signal?.aborted) throw new Error("Request was aborted");
						if (!isLastEndpoint && isRetriableTransportError(err)) break; // try fallback endpoint
						throw err;
					}

					if (options?.onResponse) {
						const responseHeaders: Record<string, string> = {};
						response.headers.forEach((val, key) => {
							responseHeaders[key] = val;
						});
						await options.onResponse({ status: response.status, headers: responseHeaders }, model);
					}

					if (!response.ok) {
						const errorText = await response.text().catch(() => "");
						if (response.status === 429) {
							invalidateQuotaCache();
						}
						if (isRetriableStatus(response.status) && attempt < MAX_EMPTY_RETRIES) {
							await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, options?.signal);
							resetOutput();
							continue;
						}
						if (!isLastEndpoint && (isRetriableStatus(response.status) || response.status === 404)) break; // try fallback endpoint
						if (response.status === 429) {
							throw new Error(
								`Cloud Code Assist rate limit exceeded (HTTP 429). Check /google-quota for reset times. Upstream: ${errorText}`,
							);
						}
						throw new Error(`Cloud Code Assist API error (${response.status}): ${errorText}`);
					}

					let meaningful = false;
					try {
						meaningful = await consumeResponse(response);
					} catch (err) {
						if (options?.signal?.aborted) throw new Error("Request was aborted");
						if (isRetriableTransportError(err) && attempt < MAX_EMPTY_RETRIES) {
							await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, options?.signal);
							resetOutput();
							continue;
						}
						throw err;
					}

					if (
						output.stopReason === "error" &&
						output.errorMessage?.includes("MALFORMED_FUNCTION_CALL") &&
						attempt < MAX_EMPTY_RETRIES
					) {
						await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt, options?.signal);
						resetOutput();
						continue;
					}

					if ((output.stopReason !== "pending" && output.stopReason !== "error") || meaningful) {
						if (isAntigravity) antigravitySession.lastGoodEndpoint = endpoint;
						succeeded = true;
						break;
					}

					if (attempt >= MAX_EMPTY_RETRIES) break;
					resetOutput();
				}
			}

			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") {
				throw new Error(
					"Cloud Code Assist stream ended without a finish reason (connection dropped or empty response)",
				);
			}

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output,
				});
			} else {
				stream.push({
					type: "done",
					reason: output.stopReason,
					message: output,
				});
			}
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

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

const DISCOVERY_DENYLIST = new Set(["chat_20706", "chat_23310"]);

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

// ---------------------------------------------------------------------------
// Registration & Lifecycle
// ---------------------------------------------------------------------------

let quotaRefreshTimer: ReturnType<typeof setInterval> | null = null;

async function updateQuotaStatusline(ctx: ExtensionContext, force = false): Promise<void> {
	if (!ctx.hasUI) return;
	try {
		const quota = await getAntigravityQuota(force);
		const statusText = formatQuotaStatusline(quota);
		ctx.ui.setStatus("google-cca", statusText ?? undefined);
	} catch {
		// Non-fatal statusline error
	}
}

export default async function (pi: ExtensionAPI): Promise<void> {
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
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		await updateQuotaStatusline(ctx);
		if (quotaRefreshTimer) clearInterval(quotaRefreshTimer);
		quotaRefreshTimer = setInterval(() => {
			void updateQuotaStatusline(ctx, true);
		}, 180_000);
	});

	// Refresh statusline after turn ends if Google provider was involved
	pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
		if (ctx.model?.provider === "google" || ctx.model?.provider === "google-antigravity") {
			invalidateQuotaCache();
			await updateQuotaStatusline(ctx, true);
		}
	});

	// React to model changes
	pi.on("model_select", async (event, ctx: ExtensionContext) => {
		if (event.model.provider === "google" || event.model.provider === "google-antigravity") {
			await updateQuotaStatusline(ctx);
		} else if (ctx.hasUI) {
			ctx.ui.setStatus("google-cca", undefined);
		}
	});

	// Clean up background timer on session shutdown
	pi.on("session_shutdown", async () => {
		if (quotaRefreshTimer) {
			clearInterval(quotaRefreshTimer);
			quotaRefreshTimer = null;
		}
	});

	// Register /google-quota command
	pi.registerCommand("google-quota", {
		description: "Display Google Antigravity quota and window resets",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{
					value: "refresh",
					label: "refresh",
					description: "Force refresh quota from Google API",
				},
				{
					value: "help",
					label: "help",
					description: "Show quota command help",
				},
			];
			const clean = prefix.trim().toLowerCase();
			const filtered = items.filter((i) => i.value.startsWith(clean));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();
			if (sub === "help" || sub === "-h" || sub === "--help") {
				const help = [
					"# /google-quota — Antigravity Quota",
					"",
					"Usage:",
					"  `/google-quota`          — Show quota breakdown and window resets",
					"  `/google-quota refresh`  — Force refresh quota and update statusline",
					"  `/google-quota help`     — Show this help reference",
				].join("\n");
				ctx.ui.notify(help, "info");
				return;
			}

			const force = sub === "refresh";
			if (force) invalidateQuotaCache();

			const quota = await getAntigravityQuota(force);
			const banner = formatQuotaDetailBanner(quota);
			const statusText = formatQuotaStatusline(quota);
			if (statusText && ctx.hasUI) {
				ctx.ui.setStatus("google-cca", statusText);
			}
			ctx.ui.notify(banner, "info");
		},
	});
}
