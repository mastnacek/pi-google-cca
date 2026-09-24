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

import {
	isThinkingPart,
	retainThoughtSignature,
	sanitizeSurrogates,
	mapStopReasonString,
	getGeminiMajorVersion,
	requiresToolCallId,
	supportsMultimodalFunctionResponse,
	NON_VISION_USER_IMAGE_PLACEHOLDER,
	NON_VISION_TOOL_IMAGE_PLACEHOLDER,
	replaceImagesWithPlaceholder,
	downgradeUnsupportedImages,
	type GeminiPart,
	type GeminiContent,
	type GoogleThinkingLevel,
	type AnyContent,
	type ModelWire,
} from "./wire-types.ts";
import {
	CUSTOM_TOOL_SCHEMA_ALLOW,
	stripMetaSchema,
	normalizeCustomToolSchema,
	convertTools,
	type FunctionDeclaration,
} from "./schema.ts";

// Re-exported so existing consumers can keep importing from this module.
// Re-exported so existing consumers can keep importing from this module.
export { normalizeCustomToolSchema as normalizeSchemaForCCA };
export * from "./wire-types.ts";
export * from "./schema.ts";

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
