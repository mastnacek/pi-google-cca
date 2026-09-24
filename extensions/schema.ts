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
// Wire-schema normalization (normalizeCustomToolSchema)
// Cloud Code Assist maps tool schemas onto a proto Schema that rejects most
// validation/annotation keywords with INVALID_ARGUMENT "Cannot find field",
// and proto enums are strings only.
// ---------------------------------------------------------------------------

export const CUSTOM_TOOL_SCHEMA_ALLOW = new Set([
	"type",
	"description",
	"properties",
	"required",
	"items",
	"enum",
]);

export function stripMetaSchema(schema: unknown): Record<string, unknown> | undefined {
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
