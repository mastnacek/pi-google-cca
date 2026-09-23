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

function getGeminiMajorVersion(modelId: string): number | undefined {
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

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const major = getGeminiMajorVersion(modelId);
	if (major !== undefined) return major >= 3;
	return true;
}

// ---------------------------------------------------------------------------
// transformMessages
// ---------------------------------------------------------------------------

const NON_VISION_USER_IMAGE_PLACEHOLDER =
	"(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER =
	"(tool image omitted: model does not support images)";

type AnyContent = { type: string; text?: string; [key: string]: unknown };

function replaceImagesWithPlaceholder(
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

function downgradeUnsupportedImages(
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

export function transformMessages(
	messages: Message[],
	model: ModelWire,
	normalizeToolCallId?: (id: string) => string,
): Message[] {
	const toolCallIdMap = new Map<string, string>();
	const normalizedMessages = messages.map((msg) =>
		msg.content == null ? { ...msg, content: [] } : msg,
	);
	const imageAware = downgradeUnsupportedImages(normalizedMessages, model);

	const transformed = imageAware.map((msg) => {
		if (msg.role === "user") return msg;
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}
		if (msg.role === "assistant") {
			const assistantMsg = msg as Message & {
				provider?: string;
				api?: string;
				model?: string;
				stopReason?: string;
			};
			const isSameModel =
				assistantMsg.provider === model.provider &&
				(!assistantMsg.api || assistantMsg.api === model.api) &&
				assistantMsg.model === model.id;
			const transformedContent = (assistantMsg.content as AnyContent[]).flatMap(
				(block) => {
					if (block.type === "thinking") {
						const thinking = block as {
							type: "thinking";
							thinking: string;
							thinkingSignature?: string;
							redacted?: boolean;
						};
						if (thinking.redacted) return isSameModel ? [block] : [];
						if (isSameModel && thinking.thinkingSignature) return [block];
						if (!thinking.thinking || thinking.thinking.trim() === "") return [];
						if (isSameModel) return [block];
						return [{ type: "text", text: thinking.thinking }];
					}
					if (block.type === "text") {
						if (isSameModel) return [block];
						return [{ type: "text", text: block.text ?? "" }];
					}
					if (block.type === "toolCall") {
						// SAFETY: we verified the block type
						const toolCall = block as unknown as ToolCall;
						let normalized: unknown = toolCall;
						if (!isSameModel && toolCall.thoughtSignature) {
							const { thoughtSignature, ...rest } = toolCall;
							void thoughtSignature;
							normalized = rest;
						}
						if (!isSameModel && normalizeToolCallId) {
							const normalizedId = normalizeToolCallId(toolCall.id);
							if (normalizedId !== toolCall.id) {
								toolCallIdMap.set(toolCall.id, normalizedId);
								normalized = { ...(normalized as ToolCall), id: normalizedId };
							}
						}
						return [normalized];
					}
					return [block];
				},
			);
			return { ...assistantMsg, content: transformedContent };
		}
		return msg;
	});

	// Insert synthetic empty tool results for orphaned tool calls.
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as Message);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (const msg of transformed) {
		if (msg.role === "assistant") {
			insertSyntheticToolResults();
			const assistantMsg = msg as Message & { stopReason?: string };
			if (
				assistantMsg.stopReason === "error" ||
				assistantMsg.stopReason === "aborted"
			)
				continue;
			
			// SAFETY: we filter by type toolCall
			const toolCalls = (assistantMsg.content as AnyContent[]).filter(
				(b) => b.type === "toolCall",
			) as unknown as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}
			result.push(msg as Message);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(
				(msg as Message & { toolCallId: string }).toolCallId,
			);
			result.push(msg as Message);
		} else if (msg.role === "user") {
			insertSyntheticToolResults();
			result.push(msg as Message);
		} else {
			result.push(msg);
		}
	}
	insertSyntheticToolResults();
	return result;
}

// ---------------------------------------------------------------------------
// convertMessages (pi-ai / omp google-shared port, CCA flavor)
// ---------------------------------------------------------------------------

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	return signature === SKIP_THOUGHT_SIGNATURE || base64SignaturePattern.test(signature);
}

function resolveThoughtSignature(
	isSameProviderAndModel: boolean,
	signature: string | undefined,
): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature)
		? signature
		: undefined;
}

export function convertMessages(
	model: ModelWire,
	context: Context,
): GeminiContent[] {
	const contents: GeminiContent[] = [];
	const needsId = requiresToolCallId(model.id);
	const normalizeToolCallId = (id: string): string =>
		needsId ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : id;

	const transformedMessages = transformMessages(
		context.messages,
		model,
		normalizeToolCallId,
	);

	for (const msg of transformedMessages) {
		const role = (msg as { role: string }).role;
		if (role === "user" || role === "system" || role === "developer") {
			if (typeof msg.content === "string") {
				if (!msg.content || msg.content.trim() === "") continue;
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: GeminiPart[] = [];
				for (const item of msg.content as AnyContent[]) {
					if (item.type === "text") {
						const text = sanitizeSurrogates(item.text ?? "");
						if (text.trim().length === 0) continue;
						parts.push({ text });
					} else if (item.type === "image") {
						const image = item as { type: "image"; mimeType: string; data: string };
						parts.push({
							inlineData: { mimeType: image.mimeType, data: image.data },
						});
					}
				}
				if (parts.length === 0) continue;
				contents.push({ role: "user", parts });
			}
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as Message & { provider?: string; model?: string };
			const parts: GeminiPart[] = [];
			const isSameProviderAndModel =
				assistantMsg.provider === model.provider && assistantMsg.model === model.id;
			let addedSentinel = false;

			for (const block of assistantMsg.content as AnyContent[]) {
				if (block.type === "text") {
					const text = block as {
						type: "text";
						text: string;
						textSignature?: string;
					};
					const thoughtSignature = resolveThoughtSignature(
						isSameProviderAndModel,
						text.textSignature,
					);
					if ((!text.text || text.text.trim() === "") && !thoughtSignature) continue;
					parts.push({
						text: sanitizeSurrogates(text.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					const thinking = block as {
						type: "thinking";
						thinking: string;
						thinkingSignature?: string;
					};
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(
							isSameProviderAndModel,
							thinking.thinkingSignature,
						);
						if (
							(!thinking.thinking || thinking.thinking.trim() === "") &&
							!thoughtSignature
						)
							continue;
						parts.push({
							thought: true,
							text: sanitizeSurrogates(thinking.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						if (!thinking.thinking || thinking.thinking.trim() === "") continue;
						parts.push({ text: sanitizeSurrogates(thinking.thinking) });
					}
				} else if (block.type === "toolCall") {
					// SAFETY: we verified the block type
					const toolCall = block as unknown as ToolCall;
					const thoughtSignature = resolveThoughtSignature(
						isSameProviderAndModel,
						toolCall.thoughtSignature,
					);
					// Cloud Code Assist rejects unsigned function calls on Gemini models.
					let effectiveSignature = thoughtSignature;
					if (!effectiveSignature && !isSameProviderAndModel && !addedSentinel) {
						effectiveSignature = SKIP_THOUGHT_SIGNATURE;
						addedSentinel = true;
					}

					parts.push({
						functionCall: {
							name: toolCall.name,
							args: (toolCall.arguments ?? {}) as Record<string, unknown>,
							...(needsId && { id: toolCall.id }),
						},
						...(effectiveSignature && { thoughtSignature: effectiveSignature }),
					});
				}
			}
			if (parts.length === 0) continue;
			contents.push({ role: "model", parts });
		} else if (msg.role === "toolResult") {
			const toolResult = msg as Message & {
				toolName?: string;
				name?: string;
				toolCallId?: string;
				id?: string;
				isError?: boolean;
				content: AnyContent[];
			};
			
			let toolName = toolResult.toolName || toolResult.name;
			if (!toolName && (toolResult.toolCallId || toolResult.id)) {
				const targetId = toolResult.toolCallId || toolResult.id;
				const normTargetId = targetId ? normalizeToolCallId(targetId) : undefined;
				for (const prev of transformedMessages) {
					if (prev.role === "assistant" && Array.isArray(prev.content)) {
						const found = (prev.content as AnyContent[]).find(
							(c) => (c.type === "toolCall" || c.type === "tool_use") && 
							       (c.id === targetId || (c.id && normTargetId && normalizeToolCallId(c.id as string) === normTargetId))
						);
						if (found && typeof found.name === "string") {
							toolName = found.name;
							break;
						}
					}
				}
			}

			const toolCallId = toolResult.toolCallId || toolResult.id || "";
			const textContent = toolResult.content.filter((c) => c.type === "text");
			const textResult = textContent.map((c) => c.text ?? "").join("\n");
			const imageContent = model.input.includes("image")
				? toolResult.content.filter((c) => c.type === "image")
				: [];
			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;
			const multimodal = supportsMultimodalFunctionResponse(model.id);

			const responseValue = hasText
				? sanitizeSurrogates(textResult)
				: hasImages
					? "(see attached image)"
					: "";
			const imageParts: GeminiPart[] = imageContent.map((image) => {
				const img = image as { type: "image"; mimeType: string; data: string };
				return { inlineData: { mimeType: img.mimeType, data: img.data } };
			});

			const functionResponsePart: GeminiPart = {
				functionResponse: {
					name: toolName || "unknown_tool",
					response: toolResult.isError
						? { error: responseValue }
						: { output: responseValue },
					...(hasImages && multimodal && { parts: imageParts }),
					...(needsId && { id: toolCallId }),
				},
			};

			// CCA requires all function responses in a single user turn.
			const lastContent = contents[contents.length - 1];
			if (
				lastContent?.role === "user" &&
				lastContent.parts.some((p) => p.functionResponse)
			) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({ role: "user", parts: [functionResponsePart] });
			}

			// Gemini < 3: images go in a separate user message.
			if (hasImages && !multimodal) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}
	return contents;
}

// ---------------------------------------------------------------------------
// Wire-schema normalization (normalizeCustomToolSchema)
// Cloud Code Assist maps tool schemas onto a proto Schema that rejects most
// validation/annotation keywords with INVALID_ARGUMENT "Cannot find field",
// and proto enums are strings only.
// ---------------------------------------------------------------------------

const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
	"type",
	"description",
	"properties",
	"required",
	"items",
	"enum",
]);

function stripMetaSchema(schema: unknown): Record<string, unknown> | undefined {
	if (!schema || typeof schema !== "object" || Array.isArray(schema))
		return schema as Record<string, unknown> | undefined;
	const omit = new Set(["$schema", "$id", "$defs", "definitions"]);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (!omit.has(key)) out[key] = stripMetaSchema(value);
	}
	return out;
}

export function normalizeCustomToolSchema(schema: unknown): Record<string, unknown> | undefined {
	if (!schema || typeof schema !== "object") return schema as Record<string, unknown> | undefined;
	if (Array.isArray(schema)) return schema.map(normalizeCustomToolSchema) as any;

	const s = schema as Record<string, unknown>;
	const out: Record<string, unknown> = {};

	if (Array.isArray(s.anyOf)) {
		const nonNull = (s.anyOf as Array<Record<string, unknown>>).find(
			(b) => b?.type !== "null" && typeof b?.type === "string",
		);
		if (nonNull && typeof nonNull.type === "string") {
			out.type = nonNull.type;
		}
	}

	for (const [key, value] of Object.entries(s)) {
		if (!CUSTOM_TOOL_SCHEMA_ALLOW.has(key)) {
			if (key === "const" && s.enum === undefined && typeof value === "string") {
				out.enum = [value];
			}
			continue;
		}
		if (key === "type" && Array.isArray(value)) {
			const scalar = value.find((e) => typeof e === "string" && e !== "null");
			if (scalar) out.type = scalar;
			continue;
		}
		if (
			key === "properties" &&
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			const props: Record<string, unknown> = {};
			for (const [propName, propSchema] of Object.entries(value)) {
				props[propName] = normalizeCustomToolSchema(propSchema);
			}
			out.properties = props;
			continue;
		}
		if (key === "enum" && Array.isArray(value)) {
			out.enum = value.map((e) => String(e));
			out.type = "string";
			continue;
		}
		out[key] = normalizeCustomToolSchema(value);
	}

	return out;
}

// ---------------------------------------------------------------------------
// convertTools
// ---------------------------------------------------------------------------

export interface FunctionDeclaration {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/**
 * Tools → Gemini functionDeclarations with normalized `parameters` for Cloud Code Assist.
 */
export function convertTools(
	tools: Tool[],
): { functionDeclarations: FunctionDeclaration[] }[] {
	if (!tools || tools.length === 0) return [];
	return [
		{
			functionDeclarations: tools.map((tool) => {
				const schema =
					stripMetaSchema(tool.parameters) ||
					{ type: "object", properties: {} };
				return {
					name: tool.name,
					description: tool.description || "",
					parameters: normalizeCustomToolSchema(schema) as Record<string, unknown>,
				};
			}),
		},
	];
}

export { normalizeCustomToolSchema as normalizeSchemaForCCA };
