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
