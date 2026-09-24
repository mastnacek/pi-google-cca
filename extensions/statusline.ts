// Quota statusline rendering, shared by the lifecycle hooks and the command.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isStatuslineEnabled } from "./config.ts";
import { formatQuotaStatusline, getAntigravityQuota } from "./quota.ts";

/** Render (or clear) the "🪐 Antigravity: …" badge, honouring the config toggle. */
export async function updateQuotaStatusline(
	ctx: ExtensionContext,
	force = false,
): Promise<void> {
	if (!ctx.hasUI) return;
	if (!isStatuslineEnabled()) {
		ctx.ui.setStatus("google-cca", undefined);
		return;
	}
	try {
		const quota = await getAntigravityQuota(force);
		const statusText = formatQuotaStatusline(quota);
		ctx.ui.setStatus("google-cca", statusText ?? undefined);
	} catch {
		// Non-fatal statusline error
	}
}
