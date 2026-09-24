// Extracted from google-wire.ts to keep modules focused.
/**
 * Google wire-format converters and JSON Schema normalization for Cloud Code Assist / Antigravity.
 * Ported from pi-ai and oh-my-pi implementations.
 */
import type {
	Context,
	Message,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Wire types (subset of the Gemini generateContent schema we produce/consume)
// ---------------------------------------------------------------------------

export interface GeminiPart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	inlineData?: { mimeType: string; data: string };
	functionCall?: { name: string; args: Record<string, unknown>; id?: string };
	functionResponse?: {
		name: string;
		response: Record<string, unknown>;
		parts?: GeminiPart[];
		id?: string;
	};
}

export interface GeminiContent {
	role: "user" | "model";
	parts: GeminiPart[];
}

export type GoogleThinkingLevel =
	| "THINKING_LEVEL_UNSPECIFIED"
	| "MINIMAL"
	| "LOW"
	| "MEDIUM"
	| "HIGH";

export function isThinkingPart(
	part: Pick<GeminiPart, "thought" | "thoughtSignature">,
): boolean {
	return part.thought === true;
}

export function retainThoughtSignature(
	existing: string | undefined,
	incoming: string | undefined,
): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

/** Removes unpaired Unicode surrogates that break provider JSON serialization. */
export function sanitizeSurrogates(text: string): string {
	return text.replace(
		/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
		"",
	);
}

/** Map a raw string finish reason to pi's StopReason. */
export function mapStopReasonString(
	reason: string,
): "stop" | "length" | "error" {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

export function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

/** Gemini 3+ (and Claude/gpt-oss behind CCA) require explicit tool call ids. */
export function requiresToolCallId(modelId: string): boolean {
	const major = getGeminiMajorVersion(modelId);
	return (
		modelId.startsWith("claude-") ||
		modelId.startsWith("gpt-oss-") ||
		(major !== undefined && major >= 3)
	);
}

export function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const major = getGeminiMajorVersion(modelId);
	if (major !== undefined) return major >= 3;
	return true;
}

// ---------------------------------------------------------------------------
// transformMessages
// ---------------------------------------------------------------------------

export const NON_VISION_USER_IMAGE_PLACEHOLDER =
	"(image omitted: model does not support images)";

export const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
	"(tool image omitted: model does not support images)";

export type AnyContent = { type: string; text?: string; [key: string]: unknown };

export function replaceImagesWithPlaceholder(
	content: AnyContent[],
	placeholder: string,
): AnyContent[] {
	const result: AnyContent[] = [];
	let previousWasPlaceholder = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder)
				result.push({ type: "text", text: placeholder });
			previousWasPlaceholder = true;
			continue;
		}
		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}
	return result;
}

export function downgradeUnsupportedImages(
	messages: Message[],
	model: ModelWire,
): Message[] {
	if (model.input.includes("image")) return messages;
	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(
					msg.content as AnyContent[],
					NON_VISION_USER_IMAGE_PLACEHOLDER,
				),
			} as Message;
		}
		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(
					msg.content as AnyContent[],
					NON_VISION_TOOL_IMAGE_PLACEHOLDER,
				),
			} as Message;
		}
		return msg;
	});
}

/** Minimal structural type the converters need from a model. */
export interface ModelWire {
	id: string;
	provider: string;
	api: string;
	input: ("text" | "image")[];
}
