import { after, describe, it } from "node:test";
import * as assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mod from "../extensions/index.ts";

interface Item {
	value: string;
	label: string;
	description?: string;
}

const configDir = mkdtempSync(join(tmpdir(), "pi-google-cca-completions-"));
process.env.PI_GOOGLE_CCA_CONFIG = join(configDir, "pi-google-cca.json");

after(() => rmSync(configDir, { recursive: true, force: true }));

async function loadCompletion() {
	const commands: Record<string, { getArgumentCompletions: (prefix: string) => Item[] | null }> = {};
	const pi = new Proxy(
		{},
		{
			get: (_t, prop) => {
				if (prop === "registerCommand") {
					return (name: string, def: { getArgumentCompletions: (prefix: string) => Item[] | null }) => {
						commands[name] = def;
					};
				}
				if (prop === "on") return () => () => {};
				return () => {};
			},
		},
	);
	await (mod as unknown as (api: unknown) => Promise<void>)(pi);
	return commands["google-quota"]!.getArgumentCompletions;
}

const values = (items: Item[] | null) => (items ?? []).map((i) => i.value);

describe("google-quota argument completions", () => {
	it("offers the non-terminal subcommand with a trailing space for partial prefixes", async () => {
		const complete = await loadCompletion();
		const items = complete("st");
		assert.ok(items, "expected suggestions for 'st'");
		assert.deepStrictEqual(values(items), ["statusline "]);
		assert.match(items![0]!.description ?? "", /● ON|○ OFF/);
	});

	it("offers on/off as soon as the full subcommand token is typed (engine does not re-open after Tab)", async () => {
		const complete = await loadCompletion();
		assert.deepStrictEqual(values(complete("statusline")), ["statusline on", "statusline off"]);
	});

	it("offers on/off after the trailing space", async () => {
		const complete = await loadCompletion();
		assert.deepStrictEqual(values(complete("statusline ")), ["statusline on", "statusline off"]);
	});

	it("keeps both on/off while typing the value prefix", async () => {
		const complete = await loadCompletion();
		assert.deepStrictEqual(values(complete("statusline o")), ["statusline on", "statusline off"]);
	});

	it("narrows to a single terminal choice once resolved", async () => {
		const complete = await loadCompletion();
		assert.deepStrictEqual(values(complete("statusline on")), ["statusline on"]);
		assert.deepStrictEqual(values(complete("statusline off")), ["statusline off"]);
	});

	it("annotates the active value in label/description but never in value", async () => {
		const complete = await loadCompletion();
		const items = complete("statusline")!;
		const on = items.find((i) => i.value === "statusline on")!;
		const off = items.find((i) => i.value === "statusline off")!;
		assert.strictEqual(on.label, "on ✓");
		assert.match(on.description ?? "", /ACTIVE/);
		assert.strictEqual(off.label, "off");
		for (const item of items) assert.ok(!item.value.includes("✓"), `value must stay clean: ${item.value}`);
	});

	it("returns nothing for unknown prefixes and for terminal trailing-space input", async () => {
		const complete = await loadCompletion();
		assert.strictEqual(complete("zzz"), null);
		assert.strictEqual(complete("refresh "), null);
	});
});

describe("google-quota --global completions", () => {
	it("offers --global at the first level as a non-terminal row", async () => {
		const complete = await loadCompletion();
		const row = (complete("") ?? []).find((i) => i.label === "--global");
		assert.ok(row, "--global row missing");
		assert.strictEqual(row!.value, "--global ", "non-terminal rows must end with a space");
	});

	it("returns only the flag row for a bare --global", async () => {
		const complete = await loadCompletion();
		assert.deepStrictEqual(values(complete("--global")), ["--global "]);
	});

	it("re-prefixes every child value exactly once", async () => {
		const complete = await loadCompletion();
		const items = complete("--global ")!;
		assert.ok(items.length > 0, "expected suggestions under --global");
		for (const item of items) {
			assert.ok(item.value.startsWith("--global "), `unprefixed value: ${item.value}`);
			assert.ok(!item.value.slice(8).startsWith("--global"), `nested flag: ${item.value}`);
		}
		const statusline = items.find((i) => i.label === "statusline");
		assert.strictEqual(statusline!.value, "--global statusline ");
	});

	it("completes the parameter level under a --global prefix", async () => {
		const complete = await loadCompletion();
		assert.deepStrictEqual(values(complete("--global statusline"))!.sort(), [
			"--global statusline off",
			"--global statusline on",
		]);
	});

	it("keeps the active-value annotation out of --global values", async () => {
		const complete = await loadCompletion();
		for (const item of complete("--global statusline on") ?? []) {
			assert.ok(!item.value.includes("✓"), `value must stay clean: ${item.value}`);
		}
	});

	it("leaves unprefixed completions untouched", async () => {
		const complete = await loadCompletion();
		assert.deepStrictEqual(values(complete("st")), ["statusline "]);
		assert.strictEqual(complete("zzz"), null);
	});
});
