/**
 * Google wire-format converters and JSON Schema normalization for Cloud Code Assist / Antigravity.
 * Ported from pi-ai and oh-my-pi implementations.
 */
import type {
	Context,
	Message,
	Model,
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
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: GeminiPart[] = [];
				for (const item of msg.content as AnyContent[]) {
					if (item.type === "text") {
						parts.push({ text: sanitizeSurrogates(item.text ?? "") });
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
			let isFirstToolCall = true;

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
					const toolCall = block as unknown as ToolCall;
					const thoughtSignature = resolveThoughtSignature(
						isSameProviderAndModel,
						toolCall.thoughtSignature,
					);
					// Cloud Code Assist rejects an unsigned first function call on Gemini 3+ / CCA models.
					// Use SKIP_THOUGHT_SIGNATURE sentinel if no signature is present on the first tool call.
					const effectiveSignature =
						thoughtSignature || (isFirstToolCall ? SKIP_THOUGHT_SIGNATURE : undefined);
					isFirstToolCall = false;

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
				toolName: string;
				toolCallId: string;
				isError?: boolean;
				content: AnyContent[];
			};
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
					name: toolResult.toolName,
					response: toolResult.isError
						? { error: responseValue }
						: { output: responseValue },
					...(hasImages && multimodal && { parts: imageParts }),
					...(needsId && { id: toolResult.toolCallId }),
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
// Wire-schema normalization (normalizeSchemaForCCA)
// Cloud Code Assist maps tool schemas onto a proto Schema that rejects most
// validation/annotation keywords with INVALID_ARGUMENT "Cannot find field",
// and proto enums are strings only without anyOf/oneOf combiners.
// ---------------------------------------------------------------------------

const UNSUPPORTED_FIELDS = new Set([
	"$schema",
	"$ref",
	"$defs",
	"definitions",
	"$dynamicRef",
	"$dynamicAnchor",
	"examples",
	"prefixItems",
	"unevaluatedProperties",
	"unevaluatedItems",
	"patternProperties",
	"additionalProperties",
	"propertyNames",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"pattern",
	"format",
	"dependencies",
	"dependentSchemas",
	"dependentRequired",
	"x-mcp-header",
	"deprecated",
	"readOnly",
	"writeOnly",
	"$comment",
	"if",
	"then",
	"else",
	"not",
]);

function isNullSchema(node: Record<string, unknown>): boolean {
	if (node.type === "null") return true;
	if (
		Array.isArray(node.enum) &&
		node.enum.length === 1 &&
		node.enum[0] === null
	)
		return true;
	return false;
}

function stringifyEnumValues(values: unknown[]): string[] {
	return values.map((v) =>
		v === null
			? "null"
			: typeof v === "string"
				? v
				: typeof v === "number" || typeof v === "boolean"
					? String(v)
					: String(v),
	);
}

export type NormalizedSchemaNode =
	| Record<string, unknown>
	| unknown[]
	| string
	| number
	| boolean
	| null;

/** Inline `$defs`/`definitions` references before the unsupported-key strip. */
function dereference(
	value: unknown,
	defs: Map<string, unknown>,
	seen: Set<unknown>,
	depth: number,
): NormalizedSchemaNode {
	if (depth > 32) return {};
	if (Array.isArray(value))
		return value.map((v) => dereference(v, defs, seen, depth + 1));
	if (typeof value !== "object" || value === null) {
		return value as NormalizedSchemaNode;
	}
	if (seen.has(value)) return {};
	seen.add(value);
	const record = value as Record<string, unknown>;
	const ref = record.$ref;
	if (typeof ref === "string") {
		const defName = ref.startsWith("#/$defs/")
			? ref.slice("#/$defs/".length)
			: ref.startsWith("#/definitions/")
				? ref.slice("#/definitions/".length)
				: undefined;
		if (defName !== undefined) {
			const target = defs.get(defName);
			return target === undefined ? {} : dereference(target, defs, seen, depth + 1);
		}
	}
	const out: Record<string, unknown> = {};
	for (const [key, v] of Object.entries(record)) {
		if (key === "$defs" || key === "definitions") continue;
		out[key] = dereference(v, defs, seen, depth + 1);
	}
	return out;
}

/**
 * Normalizes a schema node for Cloud Code Assist's proto-backed parameters schema.
 * Merges object combiners, removes anyOf/oneOf/allOf/not, converts enums to string,
 * and strips unsupported keywords.
 */
function normalizeCcaNode(value: unknown): NormalizedSchemaNode {
	if (typeof value === "boolean") return {};
	if (typeof value !== "object" || value === null) {
		return value as NormalizedSchemaNode;
	}
	if (Array.isArray(value)) return value.map(normalizeCcaNode);

	const record = value as Record<string, unknown>;

	// Handle anyOf / oneOf / allOf composition
	const combiners = ["anyOf", "oneOf", "allOf"] as const;
	for (const combiner of combiners) {
		const rawBranches = record[combiner];
		if (Array.isArray(rawBranches) && rawBranches.length > 0) {
			const nonNullBranches = rawBranches
				.map(normalizeCcaNode)
				.filter(
					(b): b is Record<string, unknown> =>
						typeof b === "object" && b !== null && !isNullSchema(b as Record<string, unknown>),
				);

			if (nonNullBranches.length === 0) {
				return { type: "null" };
			}

			// If any branch is an object, merge properties from all object branches
			const objectBranches = nonNullBranches.filter(
				(b) => b.type === "object" || b.properties !== undefined,
			);
			if (objectBranches.length > 0) {
				const mergedProps: Record<string, unknown> = {};
				const mergedRequired: Set<string> = new Set();
				let description: string | undefined =
					typeof record.description === "string" ? record.description : undefined;

				for (const branch of objectBranches) {
					if (typeof branch.description === "string" && !description) {
						description = branch.description;
					}
					if (typeof branch.properties === "object" && branch.properties !== null) {
						for (const [k, v] of Object.entries(branch.properties as Record<string, unknown>)) {
							mergedProps[k] = v;
						}
					}
					if (Array.isArray(branch.required)) {
						for (const req of branch.required) {
							if (typeof req === "string") mergedRequired.add(req);
						}
					}
				}

				const outObj: Record<string, unknown> = {
					type: "object",
					properties: mergedProps,
				};
				if (mergedRequired.size > 0) {
					outObj.required = Array.from(mergedRequired);
				}
				if (description) {
					outObj.description = description;
				}
				return outObj;
			}

			// For scalar branches, pick the first non-null branch
			const primary = nonNullBranches[0]!;
			const outScalar: Record<string, unknown> = { ...primary };
			if (typeof record.description === "string") {
				outScalar.description = record.description;
			}
			return normalizeCcaNode(outScalar);
		}
	}

	const out: Record<string, unknown> = {};

	for (const [key, raw] of Object.entries(record)) {
		if (UNSUPPORTED_FIELDS.has(key)) continue;

		if (key === "type") {
			if (Array.isArray(raw)) {
				const nonNull = raw.filter((t) => t !== "null");
				out.type =
					nonNull.length === 1
						? nonNull[0]
						: nonNull.length > 1
							? nonNull[0]
							: "string";
			} else {
				out.type = raw;
			}
			continue;
		}
		if (key === "enum") {
			if (Array.isArray(raw)) out.enum = stringifyEnumValues(raw);
			continue;
		}
		if (key === "const") {
			out.enum = stringifyEnumValues([raw]);
			continue;
		}
		if (key === "properties" && typeof raw === "object" && raw !== null) {
			const props: Record<string, unknown> = {};
			for (const [name, schema] of Object.entries(
				raw as Record<string, unknown>,
			)) {
				props[name] = normalizeCcaNode(schema);
			}
			out.properties = props;
			continue;
		}
		if (key === "items") {
			out.items = normalizeCcaNode(raw);
			continue;
		}
		if (key === "required" && Array.isArray(raw)) {
			out.required = raw.filter((item): item is string => typeof item === "string");
			continue;
		}
		out[key] = raw;
	}

	// Bare enum without a type: proto needs the scalar type
	if (out.enum !== undefined && out.type === undefined) out.type = "string";

	return out;
}

/** Normalize a tool schema for Cloud Code Assist wire parameters. */
export function normalizeSchemaForCCA(value: unknown): Record<string, unknown> {
	const root =
		typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};

	const defs = new Map<string, unknown>();
	for (const defKey of ["$defs", "definitions"]) {
		const defContainer = root[defKey];
		if (typeof defContainer === "object" && defContainer !== null) {
			for (const [name, schema] of Object.entries(
				defContainer as Record<string, unknown>,
			)) {
				defs.set(name, schema);
			}
		}
	}

	const dereferenced = dereference(value, defs, new Set(), 0);
	const normalized = normalizeCcaNode(dereferenced);

	if (typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)) {
		const obj = normalized as Record<string, unknown>;
		if (!obj.type && obj.properties) {
			obj.type = "object";
		}
		return obj;
	}

	return { type: "object", properties: {} };
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
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description || "",
				parameters: normalizeSchemaForCCA(tool.parameters),
			})),
		},
	];
}
