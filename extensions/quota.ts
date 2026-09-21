/**
 * Quota & rate-limit discovery for Google Cloud Code Assist (Antigravity).
 * Queries Antigravity's retrieveUserQuotaSummary endpoint and falls back
 * to model-level quota info if needed.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	antigravityUserAgent,
	ensureAntigravityVersion,
	type GoogleOauthCredential,
	refreshGoogleToken,
} from "./oauth.ts";

export interface QuotaBucket {
	bucketId?: string;
	displayName?: string;
	description?: string;
	window?: string;
	remainingFraction?: number;
	remainingAmount?: number | string;
	disabled?: boolean;
	resetTime?: string;
}

export interface QuotaGroup {
	displayName?: string;
	description?: string;
	buckets?: QuotaBucket[];
}

export interface AntigravityQuotaSummary {
	buckets?: QuotaBucket[];
	groups?: QuotaGroup[];
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

	const providerKey = authData["google-antigravity"] ? "google-antigravity" : "google";
	const googleEntry = authData[providerKey] as GoogleOauthCredential | undefined;
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
			authData[providerKey] = refreshed;
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

/** Query the Antigravity user quota summary endpoint with fallback. */
export async function fetchAntigravityQuotaSummary(
	accessToken: string,
	projectId: string,
	signal?: AbortSignal,
): Promise<AntigravityQuotaSummary | null> {
	await ensureAntigravityVersion(signal);
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

	// Fallback: fetch available models and extract quota buckets
	for (const endpoint of ANTIGRAVITY_QUOTA_ENDPOINTS) {
		try {
			const timeoutSignal = AbortSignal.timeout(10_000);
			const combinedSignal = signal
				? AbortSignal.any([signal, timeoutSignal])
				: timeoutSignal;

			const res = await fetch(`${endpoint}/v1internal:fetchAvailableModels`, {
				method: "POST",
				headers,
				body: JSON.stringify({}),
				signal: combinedSignal,
			});

			if (res.ok) {
				const data = (await res.json()) as {
					models?: Record<string, {
						displayName?: string;
						quotaInfo?: { remainingFraction?: number; resetTime?: string };
					}>;
				};
				if (data.models) {
					const buckets: QuotaBucket[] = [];
					for (const [id, m] of Object.entries(data.models)) {
						if (m.quotaInfo) {
							buckets.push({
								bucketId: id,
								displayName: m.displayName || id,
								remainingFraction: m.quotaInfo.remainingFraction,
								resetTime: m.quotaInfo.resetTime,
							});
						}
					}
					if (buckets.length > 0) {
						return { buckets };
					}
				}
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
	try {
		const target = new Date(isoString).getTime();
		if (Number.isNaN(target)) return null;
		const diffMs = target - Date.now();
		if (diffMs <= 0) return "now";

		const diffMinutes = Math.floor(diffMs / 60_000);
		const days = Math.floor(diffMinutes / 1440);
		const hours = Math.floor((diffMinutes % 1440) / 60);
		const mins = diffMinutes % 60;

		if (days > 0) {
			return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
		}
		if (hours > 0) {
			return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
		}
		return `${Math.max(1, mins)}m`;
	} catch {
		return null;
	}
}

// ANSI colors for clean terminal rendering
export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_GREEN = "\x1b[38;2;95;200;140m"; // Mint green (>35% remaining)
export const ANSI_CYAN = "\x1b[38;2;95;200;230m"; // Soft cyan (title / prefix)
export const ANSI_AMBER = "\x1b[38;2;230;200;90m"; // Warning amber/yellow (15% - 35% remaining)
export const ANSI_RED = "\x1b[38;2;241;108;117m"; // Coral red (<15% remaining)
export const ANSI_LAVENDER = "\x1b[38;2;170;160;220m"; // Lavender labels (5h, Wk, 3P)
export const ANSI_DIM = "\x1b[38;2;120;124;140m"; // Dim for timers and separators

function getCapacityColor(pct: number): string {
	if (pct > 35) return ANSI_GREEN;
	if (pct > 15) return ANSI_AMBER;
	return ANSI_RED;
}

/**
 * Format compact one-line status string suitable for statusline / footer.
 * Example:
 *   "🪐 Antigravity: 5h 93% (4h27m) · Wk 77% (3d8h)"
 */
export function formatQuotaStatusline(
	summary: AntigravityQuotaSummary | null,
): string | null {
	if (!summary) return null;

	const allBuckets: QuotaBucket[] = [];
	if (summary.groups) {
		for (const g of summary.groups) {
			if (g.buckets) allBuckets.push(...g.buckets);
		}
	}
	if (summary.buckets) allBuckets.push(...summary.buckets);

	const activeBuckets = allBuckets.filter((b) => !b.disabled);
	if (activeBuckets.length === 0) return null;

	const fiveHourBucket = activeBuckets.find(
		(b) =>
			b.window?.toLowerCase().includes("5h") ||
			b.displayName?.toLowerCase().includes("5 hour") ||
			b.displayName?.toLowerCase().includes("five hour"),
	);
	const weeklyBucket = activeBuckets.find(
		(b) =>
			b.window?.toLowerCase().includes("week") ||
			b.displayName?.toLowerCase().includes("week") ||
			b.displayName?.toLowerCase().includes("7d"),
	);

	const parts: string[] = [];

	if (fiveHourBucket && fiveHourBucket.remainingFraction !== undefined) {
		const pct = Math.round(fiveHourBucket.remainingFraction * 100);
		const resetStr = formatRelativeTime(fiveHourBucket.resetTime);
		const color = getCapacityColor(pct);
		const timer = resetStr ? `${ANSI_DIM}(${resetStr})${ANSI_RESET}` : "";
		parts.push(
			`${ANSI_LAVENDER}5h${ANSI_RESET} ${color}${pct}%${ANSI_RESET}${timer ? ` ${timer}` : ""}`,
		);
	}

	if (weeklyBucket && weeklyBucket.remainingFraction !== undefined) {
		const pct = Math.round(weeklyBucket.remainingFraction * 100);
		const resetStr = formatRelativeTime(weeklyBucket.resetTime);
		const color = getCapacityColor(pct);
		const timer = resetStr ? `${ANSI_DIM}(${resetStr})${ANSI_RESET}` : "";
		parts.push(
			`${ANSI_LAVENDER}Wk${ANSI_RESET} ${color}${pct}%${ANSI_RESET}${timer ? ` ${timer}` : ""}`,
		);
	}

	if (parts.length === 0) {
		for (const b of activeBuckets.slice(0, 2)) {
			if (b.remainingFraction !== undefined) {
				const pct = Math.round(b.remainingFraction * 100);
				const name = (b.displayName || b.bucketId || "Quota").slice(0, 10);
				const color = getCapacityColor(pct);
				parts.push(`${ANSI_LAVENDER}${name}${ANSI_RESET} ${color}${pct}%${ANSI_RESET}`);
			}
		}
	}

	if (parts.length === 0) return null;

	const sep = ` ${ANSI_DIM}·${ANSI_RESET} `;
	return `${ANSI_CYAN}🪐 Antigravity:${ANSI_RESET} ${parts.join(sep)}`;
}

/** Format detailed Markdown banner for /google-quota command. */
export function formatQuotaDetailBanner(
	summary: AntigravityQuotaSummary | null,
): string {
	if (!summary) {
		return "⚠️ No active Google Antigravity quota information available. Authenticate via `/login google`.";
	}

	const lines: string[] = [
		"# 🪐 Google Cloud Code Assist (Antigravity) Quota",
		"",
	];

	if (summary.description) {
		lines.push(`> ${summary.description}`, "");
	}

	const printBucket = (b: QuotaBucket) => {
		const name = b.displayName || b.bucketId || "Standard";
		const disabledTag = b.disabled ? " *(disabled)*" : "";
		let amountStr = "Available";
		if (b.remainingFraction !== undefined) {
			amountStr = `${Math.round(b.remainingFraction * 100)}% remaining`;
		} else if (b.remainingAmount !== undefined) {
			amountStr = `${b.remainingAmount} remaining`;
		}

		const resetTime = formatRelativeTime(b.resetTime);
		const resetStr = resetTime
			? ` — resets in **${resetTime}** (${b.resetTime})`
			: "";
		lines.push(`- **${name}**: ${amountStr}${disabledTag}${resetStr}`);
		if (b.description) {
			lines.push(`  *${b.description}*`);
		}
	};

	if (summary.groups && summary.groups.length > 0) {
		for (const g of summary.groups) {
			lines.push(`### ${g.displayName || "Quota Group"}`);
			if (g.description) lines.push(`*${g.description}*`);
			if (g.buckets) {
				for (const b of g.buckets) printBucket(b);
			}
			lines.push("");
		}
	} else if (summary.buckets && summary.buckets.length > 0) {
		lines.push("### Active Quota Buckets");
		for (const b of summary.buckets) printBucket(b);
		lines.push("");
	} else {
		lines.push("No quota buckets returned by upstream API.");
	}

	return lines.join("\n");
}
