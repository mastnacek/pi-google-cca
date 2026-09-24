/**
 * User configuration for pi-google-cca.
 *
 * Cascade (lowest priority first):
 *   defaults <- ~/.pi/agent/pi-google-cca.json <- <cwd>/.pi/pi-google-cca.json
 * `--global` writes the global layer; without it the project layer is written.
 * `PI_GOOGLE_CCA_CONFIG` overrides the whole cascade (used by tests).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface GoogleCcaConfig {
	/** Render the "🪐 Antigravity: …" quota badge in the statusline. */
	statusline: boolean;
}

export const DEFAULT_CONFIG: GoogleCcaConfig = {
	statusline: true,
};

/** Explicit override; when set it replaces the whole cascade. */
export function envOverridePath(): string | undefined {
	const override = process.env.PI_GOOGLE_CCA_CONFIG;
	return override && override.trim() ? override : undefined;
}

/** Global layer: `--global` writes here (~/.pi/agent/, or PI_CODING_AGENT_DIR). */
export function globalConfigPath(): string {
	const override = process.env.PI_CODING_AGENT_DIR?.trim();
	const base = override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
	return join(base, "pi-google-cca.json");
}

/** Project layer: wins over the global layer. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ".pi", "pi-google-cca.json");
}

/** Legacy accessor kept for callers that only need "the" config path. */
export function configPath(): string {
	return envOverridePath() ?? globalConfigPath();
}

/** Layer a write lands in: env override, else global for `--global`, else project. */
export function targetConfigPath(cwd: string | undefined, isGlobal: boolean): string {
	const override = envOverridePath();
	if (override) return override;
	if (isGlobal || !cwd) return globalConfigPath();
	return projectConfigPath(cwd);
}

/** Session cwd the project layer hangs off; unset = global layer only. */
let configCwd: string | undefined;

/** Rebind the cascade to a session's project layer and refresh the cache. */
export function setConfigCwd(cwd?: string): void {
	configCwd = cwd;
	resetConfigCache();
}

let cachedConfig: GoogleCcaConfig | null = null;

function readConfigFile(path: string): Partial<GoogleCcaConfig> {
	try {
		if (existsSync(path)) {
			return JSON.parse(readFileSync(path, "utf8")) as Partial<GoogleCcaConfig>;
		}
	} catch (err) {
		console.error(`pi-google-cca: failed to read config (${path}):`, err);
	}
	return {};
}

/** Load the cascade from disk and refresh the in-memory cache. */
export function loadConfig(cwd: string | undefined = configCwd): GoogleCcaConfig {
	const override = envOverridePath();
	const merged = override
		? { ...DEFAULT_CONFIG, ...readConfigFile(override) }
		: {
				...DEFAULT_CONFIG,
				...readConfigFile(globalConfigPath()),
				...(cwd ? readConfigFile(projectConfigPath(cwd)) : {}),
			};
	cachedConfig = merged;
	return cachedConfig;
}

/** Effective config, read lazily on first access. */
export function getConfig(): GoogleCcaConfig {
	if (!cachedConfig) cachedConfig = loadConfig();
	return cachedConfig;
}

export function isStatuslineEnabled(): boolean {
	return getConfig().statusline !== false;
}

/** Persist the statusline toggle into the selected layer and update the cache. */
export function setStatuslineEnabled(
	enabled: boolean,
	isGlobal = false,
	cwd: string | undefined = configCwd,
): GoogleCcaConfig {
	const next: GoogleCcaConfig = { ...getConfig(), statusline: enabled };
	const path = targetConfigPath(cwd, isGlobal);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		renameSync(tmp, path);
	} catch (err) {
		console.error(`pi-google-cca: failed to save config (${path}):`, err);
	}
	cachedConfig = next;
	return next;
}

/** Test helper: drop the in-memory cache so the next read hits disk again. */
export function resetConfigCache(): void {
	cachedConfig = null;
}
