// Thinking/reasoning configuration per model family.
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { isClaudeModel, isGemini3Flash, isGemini3Pro, isGptModel } from "./model-catalog.ts";
// ---------------------------------------------------------------------------
// Thinking config
// ---------------------------------------------------------------------------

export interface ThinkingConfig {
	includeThoughts: boolean;
	thinkingLevel?: "LOW" | "MEDIUM" | "HIGH" | "MINIMAL";
	thinkingBudget?: number;
}

export function thinkingConfigFor(
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
