// Consumes one Cloud Code Assist SSE response into the output message.
//
// The original closures lived inside streamGoogleCca and captured `stream`,
// `output`, `toolNames`, `isLeakModel`, `isAntigravity` and `ensureStarted`.
// They now live in this factory, so the captured state is explicit.
import type { Api, AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";
import { antigravitySession } from "./cca-request.ts";
import { isThinkingPart, retainThoughtSignature } from "./google-wire.ts";
import { consumePlanningBuffer, readSseData, type CcaResponseChunk } from "./planning.ts";

let toolCallCounter = 0;

export interface CcaConsumerDeps {
	model: Model<Api>;
	stream: AssistantMessageEventStream;
	output: AssistantMessage;
	toolNames: Set<string>;
	isLeakModel: boolean;
	isAntigravity: boolean;
	ensureStarted: () => void;
}

export function createCcaConsumer(deps: CcaConsumerDeps): {
	consumeResponse: (response: Response) => Promise<boolean>;
} {
	const {
		model,
		stream,
		output,
		toolNames,
		isLeakModel,
		isAntigravity,
		ensureStarted,
	} = deps;

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

	return { consumeResponse };
}
