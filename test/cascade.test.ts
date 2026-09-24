import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	globalConfigPath,
	isStatuslineEnabled,
	loadConfig,
	projectConfigPath,
	resetConfigCache,
	setConfigCwd,
	setStatuslineEnabled,
	targetConfigPath,
} from "../extensions/config.ts";

describe("pi-google-cca config cascade", () => {
	let root: string;
	let agentDir: string;
	let projectDir: string;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousOverride = process.env.PI_GOOGLE_CCA_CONFIG;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-google-cca-cascade-"));
		agentDir = join(root, "agent");
		projectDir = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.PI_GOOGLE_CCA_CONFIG;
		setConfigCwd(undefined);
		resetConfigCache();
	});

	afterEach(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousOverride === undefined) delete process.env.PI_GOOGLE_CCA_CONFIG;
		else process.env.PI_GOOGLE_CCA_CONFIG = previousOverride;
		setConfigCwd(undefined);
		resetConfigCache();
		rmSync(root, { recursive: true, force: true });
	});

	it("defaults to enabled when neither layer exists", () => {
		assert.strictEqual(loadConfig(projectDir).statusline, true);
		assert.strictEqual(existsSync(globalConfigPath()), false);
		assert.strictEqual(existsSync(projectConfigPath(projectDir)), false);
	});

	it("lets the project layer override the global layer", () => {
		writeFileSync(globalConfigPath(), JSON.stringify({ statusline: false }), "utf8");
		assert.strictEqual(loadConfig(projectDir).statusline, false, "the global layer must apply");

		writeFileSync(projectConfigPath(projectDir), JSON.stringify({ statusline: true }), "utf8");
		assert.strictEqual(loadConfig(projectDir).statusline, true, "the project layer must win");
	});

	it("writes the layer selected by --global", () => {
		setStatuslineEnabled(false, true, projectDir);
		assert.strictEqual(
			JSON.parse(readFileSync(globalConfigPath(), "utf8")).statusline,
			false,
			"--global must write the global layer",
		);
		assert.strictEqual(existsSync(projectConfigPath(projectDir)), false);

		setStatuslineEnabled(true, false, projectDir);
		assert.strictEqual(
			JSON.parse(readFileSync(projectConfigPath(projectDir), "utf8")).statusline,
			true,
			"without --global the project layer is written",
		);
		assert.strictEqual(targetConfigPath(projectDir, true), globalConfigPath());
		assert.strictEqual(targetConfigPath(projectDir, false), projectConfigPath(projectDir));
	});

	it("follows the session cwd registered by setConfigCwd", () => {
		writeFileSync(projectConfigPath(projectDir), JSON.stringify({ statusline: false }), "utf8");
		setConfigCwd(projectDir);
		assert.strictEqual(isStatuslineEnabled(), false);

		setStatuslineEnabled(true);
		assert.strictEqual(
			JSON.parse(readFileSync(projectConfigPath(projectDir), "utf8")).statusline,
			true,
			"defaults must reuse the session cwd, not the global layer",
		);
	});

	it("lets PI_GOOGLE_CCA_CONFIG override the whole cascade", () => {
		const override = join(root, "override.json");
		writeFileSync(globalConfigPath(), JSON.stringify({ statusline: false }), "utf8");
		writeFileSync(projectConfigPath(projectDir), JSON.stringify({ statusline: false }), "utf8");
		process.env.PI_GOOGLE_CCA_CONFIG = override;
		resetConfigCache();

		assert.strictEqual(
			loadConfig(projectDir).statusline,
			true,
			"the override file is empty, so the cascade must be bypassed entirely",
		);
		assert.strictEqual(targetConfigPath(projectDir, false), override);

		setStatuslineEnabled(false, false, projectDir);
		assert.strictEqual(JSON.parse(readFileSync(override, "utf8")).statusline, false);
	});
});
