import { describe, it } from "node:test";
import * as assert from "node:assert";
import type { Context, Tool, Model, Api } from "@earendil-works/pi-ai";
import {
	convertMessages,
	convertTools,
	normalizeSchemaForCCA,
	SKIP_THOUGHT_SIGNATURE,
	type ModelWire,
} from "../extensions/google-wire.ts";
import {
	antigravityUserAgent,
	deriveAntigravitySessionId,
	parseAntigravityManifestVersion,
} from "../extensions/oauth.ts";
import {
	formatQuotaDetailBanner,
	formatQuotaStatusline,
	formatRelativeTime,
	type AntigravityQuotaSummary,
} from "../extensions/quota.ts";
import {
	BUNDLED_ANTIGRAVITY_MODELS,
	fetchAntigravityDynamicModels,
} from "../extensions/index.ts";

describe("Antigravity OAuth & Wire tests", () => {
	describe("Schema normalization (normalizeSchemaForCCA)", () => {
		it("strips unsupported fields like $schema, additionalProperties, patternProperties", () => {
			const schema = {
				$schema: "http://json-schema.org/draft-07/schema#",
				type: "object",
				additionalProperties: false,
				patternProperties: { "^foo_": { type: "string" } },
				properties: {
					name: {
						type: "string",
						description: "The name",
						minLength: 1,
						maxLength: 100,
					},
					count: {
						type: "number",
						minimum: 0,
						maximum: 10,
					},
				},
				required: ["name"],
			};

			const normalized = normalizeSchemaForCCA(schema);
			assert.strictEqual(normalized.type, "object");
			assert.strictEqual(normalized.$schema, undefined);
			assert.strictEqual(normalized.additionalProperties, undefined);
			assert.strictEqual(normalized.patternProperties, undefined);
			const props = normalized.properties as Record<string, Record<string, unknown>>;
			assert.ok(props.name);
			assert.strictEqual(props.name.type, "string");
			assert.strictEqual(props.name.description, "The name");
			assert.strictEqual(props.name.minLength, undefined);
			assert.strictEqual(props.name.maxLength, undefined);
			assert.ok(props.count);
			assert.strictEqual(props.count.type, "number");
			assert.strictEqual(props.count.minimum, undefined);
			assert.deepStrictEqual(normalized.required, ["name"]);
		});

		it("collapses anyOf with null into a single type", () => {
			const schema = {
				type: "object",
				properties: {
					optionalField: {
						anyOf: [{ type: "string" }, { type: "null" }],
					},
				},
			};
			const normalized = normalizeSchemaForCCA(schema);
			const props = normalized.properties as Record<string, Record<string, unknown>>;
			assert.strictEqual(props.optionalField.type, "string");
			assert.strictEqual(props.optionalField.anyOf, undefined);
		});

		it("stringifies enum values", () => {
			const schema = {
				type: "object",
				properties: {
					choice: {
						enum: ["active", 123, true, null],
					},
				},
			};
			const normalized = normalizeSchemaForCCA(schema);
			const props = normalized.properties as Record<string, Record<string, unknown>>;
			assert.deepStrictEqual(props.choice.enum, ["active", "123", "true", "null"]);
			assert.strictEqual(props.choice.type, "string");
		});

		it("converts tools to functionDeclarations with parameters", () => {
			const tools: Tool[] = [
				{
					name: "read_file",
					description: "Read a file from disk",
					parameters: {
						type: "object",
						properties: {
							path: { type: "string" },
						},
						required: ["path"],
					},
				},
			];
			const converted = convertTools(tools);
			assert.strictEqual(converted.length, 1);
			const decl = converted[0].functionDeclarations[0];
			assert.strictEqual(decl.name, "read_file");
			assert.strictEqual(decl.description, "Read a file from disk");
			assert.ok(decl.parameters);
			assert.strictEqual(decl.parameters.type, "object");
			const props = decl.parameters.properties as Record<string, Record<string, unknown>>;
			assert.strictEqual(props.path.type, "string");
		});
	});

	describe("Message conversion & Thought signature sentinel", () => {
		const model: ModelWire = {
			id: "gemini-3.7-flash",
			provider: "google",
			api: "google-generative-ai",
			input: ["text", "image"],
		};

		it("adds SKIP_THOUGHT_SIGNATURE sentinel on unsigned first tool call", () => {
			const context = {
				messages: [
					{ role: "user", content: "Hello" },
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "call_1",
								name: "read_file",
								arguments: { path: "test.txt" },
							},
							{
								type: "toolCall",
								id: "call_2",
								name: "grep_file",
								arguments: { pattern: "foo" },
							},
						],
					},
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "read_file",
						content: [{ type: "text", text: "file contents" }],
					},
					{
						role: "toolResult",
						toolCallId: "call_2",
						toolName: "grep_file",
						content: [{ type: "text", text: "matches" }],
					},
				],
			} as unknown as Context;

			const converted = convertMessages(model, context);
			const modelTurn = converted.find((c) => c.role === "model");
			assert.ok(modelTurn);
			assert.strictEqual(modelTurn.parts.length, 2);
			assert.strictEqual(modelTurn.parts[0].thoughtSignature, SKIP_THOUGHT_SIGNATURE);
			assert.strictEqual(modelTurn.parts[1].thoughtSignature, undefined);
		});

		it("preserves valid base64 thought signatures from the same provider and model", () => {
			const validSig = "QUJDREVGR0g=";
			const context = {
				messages: [
					{ role: "user", content: "Hello" },
					{
						role: "assistant",
						provider: "google",
						model: "gemini-3.7-flash",
						content: [
							{
								type: "text",
								text: "Let me check.",
								textSignature: validSig,
							},
							{
								type: "toolCall",
								id: "call_1",
								name: "read_file",
								arguments: { path: "test.txt" },
								thoughtSignature: validSig,
							},
						],
					},
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "read_file",
						content: [{ type: "text", text: "file contents" }],
					},
				],
			} as unknown as Context;

			const converted = convertMessages(model, context);
			const modelTurn = converted.find((c) => c.role === "model");
			assert.ok(modelTurn);
			assert.strictEqual(modelTurn.parts[0].thoughtSignature, validSig);
			assert.strictEqual(modelTurn.parts[1].thoughtSignature, validSig);
		});

		it("groups multiple tool results into a single user turn", () => {
			const context = {
				messages: [
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "tool_a",
						content: [{ type: "text", text: "result a" }],
					},
					{
						role: "toolResult",
						toolCallId: "call_2",
						toolName: "tool_b",
						content: [{ type: "text", text: "result b" }],
					},
				],
			} as unknown as Context;

			const converted = convertMessages(model, context);
			assert.strictEqual(converted.length, 1);
			assert.strictEqual(converted[0].role, "user");
			assert.strictEqual(converted[0].parts.length, 2);
			assert.strictEqual(converted[0].parts[0].functionResponse?.name, "tool_a");
			assert.strictEqual(converted[0].parts[1].functionResponse?.name, "tool_b");
		});
	});

	describe("OAuth & User Agent", () => {
		it("formats Antigravity user agent string correctly", () => {
			const ua = antigravityUserAgent();
			assert.ok(ua.startsWith("antigravity/hub/"));
			assert.ok(ua.includes("(aidev_client;"));
			assert.ok(ua.includes("os_type="));
			assert.ok(ua.includes("arch="));
			assert.ok(ua.includes("cl="));
		});

		it("parses electron-builder manifest version correctly", () => {
			const yaml = "version: 2.8.5\nfiles:\n  - url: Antigravity-2.8.5.zip\n";
			const version = parseAntigravityManifestVersion(yaml);
			assert.strictEqual(version, "2.8.5");
		});

		it("derives signed decimal session ID from user text", () => {
			const id1 = deriveAntigravitySessionId("Write a hello world program");
			const id2 = deriveAntigravitySessionId("Write a hello world program");
			assert.ok(id1.startsWith("-"));
			assert.strictEqual(id1, id2);
		});
	});

	describe("Models Catalog", () => {
		it("includes all expected Gemini, Claude, and GPT-OSS models", () => {
			const ids = new Set(BUNDLED_ANTIGRAVITY_MODELS.map((m) => m.id));
			assert.ok(ids.has("gemini-3.7-flash"));
			assert.ok(ids.has("gemini-3.5-flash"));
			assert.ok(ids.has("gemini-3.1-pro"));
			assert.ok(ids.has("gemini-3-flash"));
			assert.ok(ids.has("gemini-3-pro"));
			assert.ok(ids.has("gemini-2.5-flash"));
			assert.ok(ids.has("claude-sonnet-4-6"));
			assert.ok(ids.has("claude-opus-4-6"));
			assert.ok(ids.has("claude-sonnet-4-5"));
			assert.ok(ids.has("claude-opus-4-5"));
			assert.ok(ids.has("gpt-oss-120b"));
		});

		it("has correct maxOutputTokens for Claude models (64000 cap)", () => {
			const sonnet = BUNDLED_ANTIGRAVITY_MODELS.find((m) => m.id === "claude-sonnet-4-6");
			const opus = BUNDLED_ANTIGRAVITY_MODELS.find((m) => m.id === "claude-opus-4-6");
			assert.strictEqual(sonnet?.maxTokens, 64_000);
			assert.strictEqual(opus?.maxTokens, 64_000);
		});
	});

	describe("Quota Formatting", () => {
		it("formats relative time countdowns", () => {
			const now = Date.now();
			const future5h = new Date(now + 5 * 3600_000 + 15 * 60_000).toISOString();
			const formatted = formatRelativeTime(future5h);
			assert.ok(formatted?.includes("5h") || formatted?.includes("6h"));
		});

		it("formats statusline string with capacity colors", () => {
			const summary: AntigravityQuotaSummary = {
				buckets: [
					{
						bucketId: "5h-bucket",
						displayName: "5 Hour",
						window: "5h",
						remainingFraction: 0.85,
						resetTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
					},
					{
						bucketId: "weekly-bucket",
						displayName: "Weekly",
						window: "weekly",
						remainingFraction: 0.65,
						resetTime: new Date(Date.now() + 4 * 86400_000).toISOString(),
					},
				],
			};

			const statusline = formatQuotaStatusline(summary);
			assert.ok(statusline);
			assert.ok(statusline.includes("Antigravity"));
			assert.ok(statusline.includes("5h"));
			assert.ok(statusline.includes("85%"));
			assert.ok(statusline.includes("Wk"));
			assert.ok(statusline.includes("65%"));
		});

		it("formats detailed markdown banner", () => {
			const summary: AntigravityQuotaSummary = {
				description: "Monthly subscription quota",
				groups: [
					{
						displayName: "Gemini Models",
						buckets: [
							{
								displayName: "5-Hour Sliding Window",
								remainingFraction: 0.95,
							},
						],
					},
				],
			};

			const banner = formatQuotaDetailBanner(summary);
			assert.ok(banner.includes("Google Cloud Code Assist (Antigravity) Quota"));
			assert.ok(banner.includes("Gemini Models"));
			assert.ok(banner.includes("95% remaining"));
		});
	});
});
