/**
 * Quota & rate-limit discovery for Google Cloud Code Assist (Antigravity).
 *
 * Queries Google's internal quota summary endpoint:
 *   POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 *
 * Returns model groups (Gemini models vs 3rd-party Claude/GPT), 5-hour rolling
 * windows, and weekly allocation windows with remaining capacity and exact
 * ISO-8601 reset timestamps.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	antigravityUserAgent,
	type GoogleOauthCredential,
	refreshGoogleToken,
} from "./oauth.ts";

export interface QuotaBucket {
	bucketId: string;
	displayName?: string;
	window?: "5h" | "weekly" | string;
	resetTime?: string;
	description?: string;
	remainingFraction: number;
}

export interface QuotaGroup {
	displayName?: string;
	description?: string;
	buckets: QuotaBucket[];
}

export interface AntigravityQuotaSummary {
	groups: QuotaGroup[];
	description?: string;
}

const ANTIGRAVITY_QUOTA_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
];

const CACHE_TTL_MS = 60_000; // 1 minute
let cachedSummary: AntigravityQuotaSummary | null = null;
let lastFetchTime = 0;
let fetchInFlight: Promise<AntigravityQuotaSummary | null> | null = null;

/** Read ~/.pi/agent/auth.json for Google credentials and refresh if expired. */
export async function getValidGoogleCredential(): Promise<GoogleOauthCredential | null> {
	const authPath = join(homedir(), ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return null;

	let authData: Record<string, unknown>;
	try {
		authData = JSON.parse(readFileSync(authPath, "utf8"));
	} catch {
		return null;
	}

	const googleEntry = authData["google"] as GoogleOauthCredential | undefined;
	if (!googleEntry || typeof googleEntry !== "object") return null;
	if (!googleEntry.access && !googleEntry.refresh) return null;

	// Check expiration (buffer 2 minutes)
	const isExpired =
		typeof googleEntry.expires === "number" &&
		Date.now() + 120_000 >= googleEntry.expires;

	if (isExpired && googleEntry.refresh) {
		try {
			const refreshed = (await refreshGoogleToken(
				googleEntry,
			)) as GoogleOauthCredential;
			authData["google"] = refreshed;
			const tempPath = `${authPath}.${Date.now()}.tmp`;
			writeFileSync(tempPath, JSON.stringify(authData, null, 2), "utf8");
			renameSync(tempPath, authPath);
			return refreshed;
		} catch {
			return googleEntry;
		}
	}

	return googleEntry;
}

/** Query the Antigravity user quota summary endpoint. */
export async function fetchAntigravityQuotaSummary(
	accessToken: string,
	projectId: string,
	signal?: AbortSignal,
): Promise<AntigravityQuotaSummary | null> {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"User-Agent": antigravityUserAgent(),
	};
	const body = JSON.stringify({ project: projectId });

	for (const endpoint of ANTIGRAVITY_QUOTA_ENDPOINTS) {
		try {
			const timeoutSignal = AbortSignal.timeout(10_000);
			const combinedSignal = signal
				? AbortSignal.any([signal, timeoutSignal])
				: timeoutSignal;

			const res = await fetch(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
				method: "POST",
				headers,
				body,
				signal: combinedSignal,
			});

			if (res.ok) {
				return (await res.json()) as AntigravityQuotaSummary;
			}
		} catch (err) {
			if (signal?.aborted) throw err;
		}
	}
	return null;
}

/**
 * Get quota summary with in-memory caching.
 * @param force If true, bypasses in-memory cache.
 */
export async function getAntigravityQuota(
	force = false,
	signal?: AbortSignal,
): Promise<AntigravityQuotaSummary | null> {
	if (!force && cachedSummary && Date.now() - lastFetchTime < CACHE_TTL_MS) {
		return cachedSummary;
	}

	if (fetchInFlight) return fetchInFlight;

	fetchInFlight = (async () => {
		try {
			const cred = await getValidGoogleCredential();
			if (!cred || !cred.access || !cred.projectId) return null;
			if (cred.variant && cred.variant !== "antigravity") return null;

			const summary = await fetchAntigravityQuotaSummary(
				cred.access,
				cred.projectId,
				signal,
			);
			if (summary) {
				cachedSummary = summary;
				lastFetchTime = Date.now();
			}
			return summary;
		} finally {
			fetchInFlight = null;
		}
	})();

	return fetchInFlight;
}

/** Invalidate cached quota so next call fetches fresh data. */
export function invalidateQuotaCache(): void {
	cachedSummary = null;
	lastFetchTime = 0;
}

/** Format ISO-8601 timestamp to relative human countdown (e.g. "4h 27m", "3d 8h", "15m"). */
export function formatRelativeTime(isoString?: string): string | null {
	if (!isoString) return null;
	const target = new Date(isoString).getTime();
	if (Number.isNaN(target)) return null;

	const diffMs = target - Date.now();
	if (diffMs <= 0) return "0m";

	const totalMins = Math.floor(diffMs / 60_000);
	const days = Math.floor(totalMins / (24 * 60));
	const hours = Math.floor((totalMins % (24 * 60)) / 60);
	const mins = totalMins % 60;

	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${mins}m`;
	return `${mins}m`;
}

// ANSI colors for clean, theme-friendly terminal rendering
export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_GREEN = "\x1b[38;2;95;200;140m"; // Mint green (>35% remaining)
export const ANSI_CYAN = "\x1b[38;2;95;200;230m"; // Soft cyan (title / prefix)
export const ANSI_AMBER = "\x1b[38;2;230;200;90m"; // Warning amber/yellow (15% - 35% remaining)
export const ANSI_RED = "\x1b[38;2;241;108;117m"; // Coral red (<15% remaining)
export const ANSI_LAVENDER = "\x1b[38;2;170;160;220m"; // Lavender labels (5h, Wk, 3P)
export const ANSI_DIM = "\x1b[38;2;120;124;140m"; // Dim for timers and separators

function getCapacityColor(pct: number): string {
	if (pct <= 15) return ANSI_RED;
	if (pct <= 35) return ANSI_AMBER;
	return ANSI_GREEN;
}

/**
 * Format compact one-line status string suitable for statusline / footer.
 * Example output:
 *   "🪐 Antigravity: 5h 93% (4h27m) · Wk 77% (3d8h)"
 */
export function formatQuotaStatusline(
	summary: AntigravityQuotaSummary | null,
): string | null {
	if (
		!summary ||
		!Array.isArray(summary.groups) ||
		summary.groups.length === 0
	) {
		return null;
	}

	// 1. Find Gemini group (Flash & Pro models)
	const geminiGroup =
		summary.groups.find((g) => g.displayName?.toLowerCase().includes("gemini")) ??
		summary.groups[0];

	if (!geminiGroup) return null;

	const b5h = geminiGroup.buckets.find(
		(b) => b.window === "5h" || b.bucketId.includes("5h"),
	);
	const bWk = geminiGroup.buckets.find(
		(b) => b.window === "weekly" || b.bucketId.includes("weekly"),
	);

	const parts: string[] = [];

	const formatSegment = (label: string, bucket: QuotaBucket) => {
		const pct = Math.round(bucket.remainingFraction * 100);
		const color = getCapacityColor(pct);
		const rel = bucket.resetTime ? formatRelativeTime(bucket.resetTime) : null;
		const rstPart =
			rel && pct < 100 ? ` ${ANSI_DIM}(rst ${rel})${ANSI_RESET}` : "";
		return `${ANSI_LAVENDER}${label}${ANSI_RESET} ${ANSI_BOLD}${color}${pct}% left${ANSI_RESET}${rstPart}`;
	};

	if (b5h) {
		parts.push(formatSegment("5h", b5h));
	}

	if (bWk) {
		parts.push(formatSegment("Wk", bWk));
	}

	// 2. Check 3rd-party models (Claude & GPT) if quota has been consumed
	const p3Group = summary.groups.find(
		(g) =>
			g.displayName?.toLowerCase().includes("claude") ||
			g.displayName?.toLowerCase().includes("gpt"),
	);
	if (p3Group) {
		const p3_5h = p3Group.buckets.find(
			(b) => b.window === "5h" || b.bucketId.includes("5h"),
		);
		if (p3_5h && p3_5h.remainingFraction < 1) {
			parts.push(formatSegment("3P", p3_5h));
		}
	}

	if (parts.length === 0) return null;
	const sep = ` ${ANSI_DIM}·${ANSI_RESET} `;
	return `🪐 ${ANSI_BOLD}${ANSI_CYAN}Antigravity:${ANSI_RESET} ${parts.join(sep)}`;
}

/** Format detailed Markdown banner for /google-quota command. */
export function formatQuotaDetailBanner(
	summary: AntigravityQuotaSummary | null,
): string {
	if (!summary) {
		return "Unable to retrieve Antigravity quota information. Verify active Google OAuth session via `/login google`.";
	}

	const lines: string[] = ["# Google Antigravity Quota & Reset Windows", ""];

	for (const group of summary.groups) {
		lines.push(`### ${group.displayName ?? "Model Group"}`);
		if (group.description) lines.push(`_${group.description}_`);
		lines.push("");

		for (const bucket of group.buckets) {
			const pct = Math.round(bucket.remainingFraction * 100);
			const rel = formatRelativeTime(bucket.resetTime);
			const resetStr = bucket.resetTime
				? `resets in **${rel}** (${bucket.resetTime.replace("T", " ").replace("Z", " UTC")})`
				: "no reset timestamp";

			lines.push(
				`- **${bucket.displayName ?? bucket.window ?? bucket.bucketId}**: **${pct}%** remaining · ${resetStr}`,
			);
		}
		lines.push("");
	}

	if (summary.description) {
		lines.push("---");
		lines.push(`ℹ️ ${summary.description}`);
	}

	return lines.join("\n");
}
