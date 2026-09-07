import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  type GoogleCcaConfig,
  loadCcaConfig,
  saveCcaConfig,
} from "./config.ts";

export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_GREEN = "\x1b[38;2;95;200;140m";
export const ANSI_CYAN = "\x1b[38;2;95;200;230m";
export const ANSI_AMBER = "\x1b[38;2;218;165;32m";
export const ANSI_DIM = "\x1b[38;2;120;124;140m";

const COMMAND_DOCS = {
  headroom: "configure Headroom context compression (on | off)",
  status: "display active Google CCA configuration and Headroom routing status",
  help: "display command reference and help banner",
} as const;

export async function isHeadroomAlive(host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function buildHelpText(
  config: GoogleCcaConfig,
): Promise<string> {
  const proxyAlive = await isHeadroomAlive(config.headroomHost, config.headroomPort);

  const headroomBadge = config.headroom
    ? `${ANSI_BOLD}${ANSI_GREEN}● Enabled${ANSI_RESET}`
    : `${ANSI_BOLD}${ANSI_DIM}○ Disabled${ANSI_RESET}`;

  const proxyBadge = proxyAlive
    ? `${ANSI_BOLD}${ANSI_GREEN}● Online${ANSI_RESET} (:${config.headroomPort})`
    : `${ANSI_BOLD}${ANSI_DIM}○ Offline${ANSI_RESET}`;

  return [
    `${ANSI_BOLD}${ANSI_CYAN}☁️ pi-google-cca${ANSI_RESET} — Google Cloud Code Assist & Antigravity Suite`,
    `OAuth-authenticated Gemini streaming with automatic Headroom context compression.`,
    ``,
    `${ANSI_BOLD}Commands & Subcommands:${ANSI_RESET}`,
    `  /cca headroom on             — route Google CCA calls through Headroom proxy`,
    `  /cca headroom off            — route Google CCA calls directly to Google`,
    `  /cca status                  — show active routing and proxy status`,
    `  /cca help                    — display this reference guide`,
    ``,
    `${ANSI_DIM}Tip: Append --global to any command to persist setting across all sessions.${ANSI_RESET}`,
    ``,
    `${ANSI_BOLD}Current Runtime Overview:${ANSI_RESET}`,
    `  • Headroom Routing: ${headroomBadge} | Headroom Proxy: ${proxyBadge}`,
    `  • Upstream Target: ${config.headroom && proxyAlive ? `http://${config.headroomHost}:${config.headroomPort} (Proxy)` : "Google Cloud Code Assist (Direct)"}`,
  ].join("\n");
}

export function registerCcaCommands(
  pi: ExtensionAPI,
  getConfig: () => GoogleCcaConfig,
  updateConfig: (next: GoogleCcaConfig) => void,
): void {
  const getCompletions = async (
    prefix: string,
  ): Promise<AutocompleteItem[] | null> => {
    const tokens = prefix.split(/\s+/).filter(Boolean);
    const trailingSpace = /\s$/.test(prefix);
    const normalizedPrefix = tokens.join(" ").toLowerCase();

    // 2nd/3rd Token Completion
    if (tokens.length > 1 || (trailingSpace && tokens.length === 1)) {
      const cmd = tokens[0]?.toLowerCase();

      if (cmd === "headroom") {
        const options = [
          {
            value: "headroom on",
            label: "headroom on",
            description: "Enable Headroom context compression (session/project)",
          },
          {
            value: "headroom on --global",
            label: "headroom on --global",
            description: "Enable Headroom context compression globally for all sessions",
          },
          {
            value: "headroom off",
            label: "headroom off",
            description: "Disable Headroom compression (direct to Google)",
          },
          {
            value: "headroom off --global",
            label: "headroom off --global",
            description: "Disable Headroom compression globally for all sessions",
          },
        ];
        const filtered = options.filter((i) =>
          i.value.toLowerCase().startsWith(normalizedPrefix),
        );
        return filtered.length > 0 ? filtered : null;
      }

      if (["status", "help"].includes(cmd || "")) {
        return null;
      }

      return null;
    }

    // 1st Token Completion
    const typed = (tokens[0] ?? "").toLowerCase();
    const items: AutocompleteItem[] = [];
    for (const [value, description] of Object.entries(COMMAND_DOCS)) {
      if (value.toLowerCase().startsWith(typed)) {
        items.push({ value, label: value, description });
      }
    }

    return items.length > 0 ? items : null;
  };

  const commandHandler = async (
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => {
    const trimmed = args.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const isGlobal = tokens.some((t) => t.toLowerCase() === "--global");
    const cleanTokens = tokens.filter((t) => t.toLowerCase() !== "--global");

    const subcommand = (cleanTokens[0] ?? "").toLowerCase();
    const action = (cleanTokens[1] ?? "").toLowerCase();

    let config = getConfig();

    if (!subcommand || ["help", "-h", "--help"].includes(subcommand)) {
      const helpText = await buildHelpText(config);
      ctx.ui.notify(helpText, "info");
      return;
    }

    switch (subcommand) {
      case "headroom": {
        if (action === "on" || action === "enable" || action === "true") {
          config = saveCcaConfig(ctx.cwd, { headroom: true }, isGlobal);
          updateConfig(config);
          const alive = await isHeadroomAlive(config.headroomHost, config.headroomPort);
          const proxyNote = alive
            ? `Proxy active on :${config.headroomPort}`
            : `Warning: Headroom proxy offline on :${config.headroomPort} (will fallback to direct until proxy starts)`;
          ctx.ui.notify(
            `⚡ Google CCA Headroom routing enabled${isGlobal ? " (globally)" : ""}. ${proxyNote}`,
            "info",
          );
          break;
        }

        if (action === "off" || action === "disable" || action === "false") {
          config = saveCcaConfig(ctx.cwd, { headroom: false }, isGlobal);
          updateConfig(config);
          ctx.ui.notify(
            `Google CCA Headroom routing disabled${isGlobal ? " (globally)" : ""} (routing directly to Google).`,
            "info",
          );
          break;
        }

        ctx.ui.notify(
          `Invalid headroom option "${action}". Use: /cca headroom on|off [--global]`,
          "warning",
        );
        break;
      }

      case "status": {
        const helpText = await buildHelpText(config);
        ctx.ui.notify(helpText, "info");
        break;
      }

      default:
        ctx.ui.notify(
          `Unknown subcommand "${subcommand}". Use: /cca help`,
          "warning",
        );
        break;
    }
  };

  pi.registerCommand("cca", {
    description: "Manage Google Cloud Code Assist OAuth and Headroom routing",
    getArgumentCompletions: getCompletions,
    handler: commandHandler,
  });

  pi.registerCommand("google-cca", {
    description: "Alias for /cca",
    getArgumentCompletions: getCompletions,
    handler: commandHandler,
  });
}
