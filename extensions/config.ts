import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface GoogleCcaConfig {
  /** Route Cloud Code Assist / Antigravity calls through Headroom proxy */
  headroom: boolean;
  /** Headroom proxy host (default: 127.0.0.1) */
  headroomHost: string;
  /** Headroom proxy port (default: 8787) */
  headroomPort: number;
}

export const DEFAULT_CCA_CONFIG: GoogleCcaConfig = {
  headroom: true,
  headroomHost: "127.0.0.1",
  headroomPort: 8787,
};

export const GLOBAL_CCA_CONFIG_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "google-cca.json",
);

export function getProjectCcaConfigPath(cwd: string): string {
  return resolve(cwd, ".pi", "google-cca.json");
}

export function loadCcaConfig(cwd: string): GoogleCcaConfig {
  const candidates = [
    getProjectCcaConfigPath(cwd),
    GLOBAL_CCA_CONFIG_PATH,
  ];

  let config = { ...DEFAULT_CCA_CONFIG };

  // Read global first, then override with project config if exists
  for (let i = candidates.length - 1; i >= 0; i--) {
    const file = candidates[i];
    if (file && existsSync(file)) {
      try {
        const raw = readFileSync(file, "utf8");
        const parsed = JSON.parse(raw);
        config = { ...config, ...parsed };
      } catch {
        // Non-fatal parse fallback
      }
    }
  }

  return config;
}

export function saveCcaConfig(
  cwd: string,
  updates: Partial<GoogleCcaConfig>,
  isGlobal = false,
): GoogleCcaConfig {
  const current = loadCcaConfig(cwd);
  const next = { ...current, ...updates };

  const targetPath = isGlobal ? GLOBAL_CCA_CONFIG_PATH : getProjectCcaConfigPath(cwd);
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    const tempPath = `${targetPath}.${Date.now()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(next, null, 2), "utf8");
    try {
      renameSync(tempPath, targetPath);
    } catch {
      writeFileSync(targetPath, JSON.stringify(next, null, 2), "utf8");
    }
  } catch (err) {
    console.error("[pi-google-cca] Failed to save config:", targetPath, err);
  }

  return next;
}
