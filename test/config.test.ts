import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isStatuslineEnabled,
	loadConfig,
	resetConfigCache,
	setStatuslineEnabled,
} from "../extensions/config.ts";

describe("pi-google-cca config", () => {
	let dir: string;
	let path: string;
	const previousOverride = process.env.PI_GOOGLE_CCA_CONFIG;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-google-cca-config-"));
		path = join(dir, "pi-google-cca.json");
		process.env.PI_GOOGLE_CCA_CONFIG = path;
		resetConfigCache();
	});

	afterEach(() => {
		if (previousOverride === undefined) {
			delete process.env.PI_GOOGLE_CCA_CONFIG;
		} else {
			process.env.PI_GOOGLE_CCA_CONFIG = previousOverride;
		}
		resetConfigCache();
		rmSync(dir, { recursive: true, force: true });
	});

	it("defaults to statusline enabled when no config file exists", () => {
		assert.strictEqual(isStatuslineEnabled(), true);
		assert.strictEqual(existsSync(path), false);
	});

	it("persists the statusline toggle to disk", () => {
		setStatuslineEnabled(false);
		assert.strictEqual(isStatuslineEnabled(), false);

		const persisted = JSON.parse(readFileSync(path, "utf8"));
		assert.strictEqual(persisted.statusline, false);

		resetConfigCache();
		assert.strictEqual(loadConfig().statusline, false);
		assert.strictEqual(isStatuslineEnabled(), false);
	});

	it("re-enables the statusline and rewrites the file", () => {
		setStatuslineEnabled(false);
		setStatuslineEnabled(true);
		assert.strictEqual(isStatuslineEnabled(), true);
		assert.strictEqual(JSON.parse(readFileSync(path, "utf8")).statusline, true);
	});

	it("falls back to defaults when the config file is corrupt", () => {
		writeFileSync(path, "{ not valid json", "utf8");
		resetConfigCache();
		assert.strictEqual(loadConfig().statusline, true);
	});
});
