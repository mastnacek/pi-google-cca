// SSE reading and planning-leak filtering (models that emit planning JSON as text).
// ---------------------------------------------------------------------------
// Response streaming & Planning leak guard
// ---------------------------------------------------------------------------

export interface CcaResponseChunk {
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

export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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

export function isPlanningLeakPrefix(text: string): boolean {
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

export function splitLeadingJsonObject(
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

export function isPlanningLeakObject(parsed: unknown, toolNames: Set<string>): boolean {
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

export type BufferedPlanning =
	| { kind: "incomplete" }
	| { kind: "plain"; visibleText: string }
	| { kind: "leak"; visibleText: string };

export function consumePlanningBuffer(
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
