// /google-quota command: quota display plus the statusline toggle.
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	globalConfigPath,
	isStatuslineEnabled,
	projectConfigPath,
	setStatuslineEnabled,
	targetConfigPath,
} from "./config.ts";
import {
	formatQuotaDetailBanner,
	formatQuotaStatusline,
	getAntigravityQuota,
	invalidateQuotaCache,
} from "./quota.ts";
import { updateQuotaStatusline } from "./statusline.ts";

interface Item {
	value: string;
	label: string;
	description?: string;
}

/** `--global` row offered at the first level. */
const GLOBAL_ROW: Item = {
	value: "--global ",
	label: "--global",
	description: "Write the setting to ~/.pi/agent/ instead of the project",
};

/** Split `--global` out of the argument line (accepted as prefix or suffix). */
function parseArgs(raw: string): { isGlobal: boolean; tokens: string[] } {
	const all = raw.trim().split(/\s+/).filter(Boolean);
	const isGlobal = all.some((t) => t.toLowerCase() === "--global");
	return { isGlobal, tokens: all.filter((t) => t.toLowerCase() !== "--global") };
}

export function getCompletions(prefix: string): Item[] | null {
	// `--global` prefix: complete the remainder, then re-prefix the suggestions.
	const trimmed = prefix.trimStart();
	if (trimmed.startsWith("--global")) {
		const afterGlobal = trimmed.slice(8).trimStart();
		const hasTrailingSpace = trimmed.length > 8 || /\s$/.test(prefix);
		if (!hasTrailingSpace && afterGlobal === "") return [GLOBAL_ROW];
		const sub = getCompletions(afterGlobal);
		if (!sub) return null;
		const out: Item[] = [];
		for (const item of sub) {
			if (item.label === "--global") continue;
			out.push({
				value: `--global ${item.value}`,
				label: item.label,
				description: item.description,
			});
		}
		return out.length > 0 ? out : null;
	}

	const tokens = prefix.split(/\s+/).filter(Boolean);
	const trailingSpace = /\s$/.test(prefix);
	const firstToken = tokens[0]?.toLowerCase();

	// Non-terminal subcommands whose parameters are enumerable.
	// A fully-typed token (no trailing space) must ALREADY yield the
	// parameter list. Reason: the engine closes the picker after Tab and
	// never re-opens it for the trailing-space form
	// (`handleTabCompletion` forces FILE completion once a space exists),
	// so relying on the trailing space alone strands the user at level 1.
	const NON_TERMINAL = new Set(["statusline"]);
	const atParameterLevel =
		tokens.length > 1 ||
		(trailingSpace && tokens.length === 1) ||
		(tokens.length === 1 && firstToken !== undefined && NON_TERMINAL.has(firstToken));

	// Second level: /google-quota statusline on|off
	if (atParameterLevel) {
		const cmd = firstToken;
		if (cmd === "statusline") {
			const enabled = isStatuslineEnabled();
			const items = [
				{
					value: "statusline on",
					label: enabled ? "on ✓" : "on",
					description: `Show the quota statusline badge${enabled ? " · ● ACTIVE" : ""}`,
				},
				{
					value: "statusline off",
					label: enabled ? "off" : "off ✓",
					description: `Hide the quota statusline badge${enabled ? "" : " · ● ACTIVE"}`,
				},
			];
			const clean = prefix.trim().toLowerCase();
			const filtered = items.filter((i) => i.value.toLowerCase().startsWith(clean));
			return filtered.length > 0 ? filtered : null;
		}
		return null;
	}

	// First level
	const enabled = isStatuslineEnabled();
	const items: Item[] = [
		{
			value: "refresh",
			label: "refresh",
			description: "Force refresh quota from Google API",
		},
		{
			value: "statusline ",
			label: "statusline",
			description: `Show or hide the quota statusline badge · ${enabled ? "● ON" : "○ OFF"}`,
		},
		{
			value: "help",
			label: "help",
			description: "Show quota command help",
		},
	];
	const clean = prefix.trim().toLowerCase();
	if ("--global".startsWith(clean)) items.push(GLOBAL_ROW);
	const filtered = items.filter((i) => i.label.toLowerCase().startsWith(clean));
	return filtered.length > 0 ? filtered : null;
}

export function registerGoogleQuotaCommand(pi: ExtensionAPI): void {
	pi.registerCommand("google-quota", {
		description: "Display Google Antigravity quota and window resets",
		getArgumentCompletions: (prefix: string) => getCompletions(prefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const { isGlobal, tokens } = parseArgs(args);
			const sub = tokens.join(" ").toLowerCase();
			const scope = isGlobal ? "globally" : "for this project";

			if (sub === "help" || sub === "-h" || sub === "--help") {
				const help = [
					"# /google-quota — Antigravity Quota",
					"",
					`global:   ${globalConfigPath()}`,
					`project:  ${projectConfigPath(ctx.cwd)}`,
					`write:    ${targetConfigPath(ctx.cwd, isGlobal)}${isGlobal ? "  (--global)" : ""}`,
					"",
					"Usage:",
					"  `/google-quota`                    — Show quota breakdown and window resets",
					"  `/google-quota refresh`            — Force refresh quota and update statusline",
					"  `/google-quota statusline on|off`  — Show or hide the statusline badge",
					"  `/google-quota help`               — Show this help reference",
					"",
					"Add --global (before or after the setting) to write ~/.pi/agent/",
					"instead of the project layer; without it the change goes to <cwd>/.pi/.",
				].join("\n");
				if (ctx.hasUI) ctx.ui.notify(help, "info");
				return;
			}

			if (sub === "statusline" || sub.startsWith("statusline ")) {
				const value = tokens[1]?.toLowerCase();
				if (value === "on" || value === "off") {
					const enabled = value === "on";
					setStatuslineEnabled(enabled, isGlobal, ctx.cwd);
					await updateQuotaStatusline(ctx, true);
					if (ctx.hasUI) {
						ctx.ui.notify(
							enabled
								? `Quota statusline badge enabled ${scope}.`
								: `Quota statusline badge disabled ${scope}.`,
							"info",
						);
					}
					return;
				}
				const state = isStatuslineEnabled() ? "on" : "off";
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Quota statusline is currently ${state}. Use \`/google-quota statusline on|off\` (add --global to write ~/.pi/agent/).`,
						"info",
					);
				}
				return;
			}

			const force = sub === "refresh";
			if (force) invalidateQuotaCache();

			const quota = await getAntigravityQuota(force);
			const banner = formatQuotaDetailBanner(quota);
			const statusText = formatQuotaStatusline(quota);
			if (statusText && ctx.hasUI && isStatuslineEnabled()) {
				ctx.ui.setStatus("google-cca", statusText);
			}
			if (ctx.hasUI) ctx.ui.notify(banner, "info");
		},
	});
}
