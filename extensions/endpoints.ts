// Endpoint constants and the CLI user-agent string.
export const GEMINI_CLI_ENDPOINT = "https://cloudcode-pa.googleapis.com";

export const ANTIGRAVITY_PRIMARY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";

export const ANTIGRAVITY_SANDBOX_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

export const ANTIGRAVITY_ENDPOINTS = [
	ANTIGRAVITY_PRIMARY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
];

export const REQUEST_TIMEOUT_MS = 300_000;

export const MAX_RETRIES = 3;

export const RETRY_BASE_DELAY_MS = 1_000;

export function geminiCliUserAgent(modelId: string): string {
	const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.46.0";
	const platform = process.platform === "win32" ? "win32" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}
