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

	if (b5h) {
		const pct = Math.round(b5h.remainingFraction * 100);
		const rel = b5h.resetTime ? formatRelativeTime(b5h.resetTime) : null;
		parts.push(`5h ${pct}%${rel && pct < 100 ? ` (${rel})` : ""}`);
	}

	if (bWk) {
		const pct = Math.round(bWk.remainingFraction * 100);
		const rel = bWk.resetTime ? formatRelativeTime(bWk.resetTime) : null;
		parts.push(`Wk ${pct}%${rel && pct < 100 ? ` (${rel})` : ""}`);
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
			const pct = Math.round(p3_5h.remainingFraction * 100);
			const rel = p3_5h.resetTime ? formatRelativeTime(p3_5h.resetTime) : null;
			parts.push(`3P ${pct}%${rel ? ` (${rel})` : ""}`);
		}
	}

	if (parts.length === 0) return null;
	return `🪐 Antigravity: ${parts.join(" · ")}`;
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
