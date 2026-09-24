// Cloud Code Assist request construction.
import { randomUUID } from "node:crypto";
import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { convertMessages, convertTools, type ModelWire } from "./google-wire.ts";
import {
	ANTIGRAVITY_WIRE_PROFILES,
	antigravityWireModelId,
	isClaudeModel,
} from "./model-catalog.ts";
import { deriveAntigravitySessionId } from "./oauth.ts";
import { thinkingConfigFor, type ThinkingConfig } from "./thinking.ts";

/** Sticky per-process session state used for Antigravity request routing. */// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface CcaRequest {
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

export const antigravitySession: {
	agentId?: string;
	trajectoryId?: string;
	sessionId?: string;
	stepIndex?: number;
	lastExecutionId?: string;
	lastGoodEndpoint?: string;
} = {};

export function firstUserText(context: Context): string | undefined {
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

export function buildCcaRequest(
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

	// pi-ai 0.86.0+ places system prompts inside context.messages instead of context.systemPrompt
	const allMessages = context.messages as Array<{ role: string; content: any }>;
	const systemMessages = allMessages.filter((m) => m.role === "system");
	const derivedSystemPrompt =
		(context.systemPrompt && context.systemPrompt.trim().length > 0)
			? context.systemPrompt
			: systemMessages
					.map((m) => {
						if (typeof m.content === "string") return m.content;
						if (Array.isArray(m.content)) {
							return m.content
								.filter((c: any) => c.type === "text")
								.map((c: any) => c.text)
								.join("\n");
						}
						return "";
					})
					.join("\n\n");

	if (derivedSystemPrompt && derivedSystemPrompt.trim().length > 0) {
		// Antigravity tags systemInstruction with role "user" (mirrors the real client).
		request.systemInstruction = {
			...(isAntigravity ? { role: "user" } : {}),
			parts: [{ text: derivedSystemPrompt }],
		};
	}

	const wireModelId = isAntigravity
		? antigravityWireModelId(model.id, typeof options?.reasoning === "string" ? options.reasoning : undefined)
		: model.id;
	const isClaude = isClaudeModel(model.id) || isClaudeModel(wireModelId);

	if (context.tools && context.tools.length > 0) {
		request.tools = convertTools(context.tools);
	}
	
	const toolChoice = (options as any)?.toolChoice;
	if (toolChoice && toolChoice !== "auto" && toolChoice !== "Auto") {
		let mode: "AUTO" | "ANY" | "NONE" | "VALIDATED" = "AUTO";
		const tc = String(toolChoice).toLowerCase();
		if (tc === "none") mode = "NONE";
		else if (tc === "any" || tc === "required") mode = "ANY";
		request.toolConfig = {
			functionCallingConfig: { mode },
		};
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
