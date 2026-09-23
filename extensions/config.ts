/**
 * Global user configuration for pi-google-cca.
 *
 * Stored at ~/.pi/agent/pi-google-cca.json so the choice survives sessions.
 * `PI_GOOGLE_CCA_CONFIG` overrides the path (used by tests).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface GoogleCcaConfig {
	/** Render the "🪐 Antigravity: …" quota badge in the statusline. */
	statusline: boolean;
}

export const DEFAULT_CONFIG: GoogleCcaConfig = {
	statusline: true,
};

export function configPath(): string {
	const override = process.env.PI_GOOGLE_CCA_CONFIG;
	if (override && override.trim()) return override;
	return join(homedir(), ".pi", "agent", "pi-google-cca.json");
}

let cachedConfig: GoogleCcaConfig | null = null;

function readConfigFile(): GoogleCcaConfig {
	const path = configPath();
	try {
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<GoogleCcaConfig>;
			return { ...DEFAULT_CONFIG, ...parsed };
		}
	} catch (err) {
		console.error("pi-google-cca: failed to read config:", err);
	}
	return { ...DEFAULT_CONFIG };
}

/** Load from disk and refresh the in-memory cache. */
export function loadConfig(): GoogleCcaConfig {
	cachedConfig = readConfigFile();
	return cachedConfig;
}

/** Effective config, read lazily on first access. */
export function getConfig(): GoogleCcaConfig {
	if (!cachedConfig) cachedConfig = readConfigFile();
	return cachedConfig;
}

export function isStatuslineEnabled(): boolean {
	return getConfig().statusline !== false;
}

/** Persist the statusline toggle and update the cache. */
export function setStatuslineEnabled(enabled: boolean): GoogleCcaConfig {
	const next: GoogleCcaConfig = { ...getConfig(), statusline: enabled };
	const path = configPath();
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(next, null, 2), "utf8");
	} catch (err) {
		console.error("pi-google-cca: failed to save config:", err);
	}
	cachedConfig = next;
	return next;
}

/** Test helper: drop the in-memory cache so the next read hits disk again. */
export function resetConfigCache(): void {
	cachedConfig = null;
}
