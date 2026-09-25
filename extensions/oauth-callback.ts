/**
 * The local loopback callback server used by the interactive login, its result
 * page, and the parser for a manually pasted redirect URL.
 * Split out of `oauth.ts`.
 */
import * as http from "node:http";
import { OAuthFlowError, type CallbackHandle } from "./oauth-types.ts";

const RESULT_PAGE = (ok: boolean, detail: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>pi — Google Login</title>
<style>body{font-family:system-ui,sans-serif;padding:3rem;background:#111;color:#eee;max-width:32rem;margin:auto}
h1{font-size:1.4rem;color:${ok ? "#4ade80" : "#f87171"}}p{color:#aaa;line-height:1.5}</style>
</head><body>
<h1>${ok ? "Authentication successful" : "Authentication failed"}</h1>
<p>${detail}</p>
<p>You can close this tab and return to the terminal.</p>
</body></html>`;

function serveCallback(
	hostname: string,
	port: number,
	callbackPath: string,
	expectedState: string,
	resolve: (r: { code: string; state: string }) => void,
	reject: (e: Error) => void,
): Promise<http.Server> {
	return new Promise((resServer, rejServer) => {
		const server = http.createServer((req, res) => {
			const parsed = new URL(req.url ?? "/", `http://${hostname}:${port}`);
			if (parsed.pathname !== callbackPath) {
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not Found");
				return;
			}
			const code = parsed.searchParams.get("code");
			const state = parsed.searchParams.get("state");
			const error = parsed.searchParams.get("error");
			const errorDescription = parsed.searchParams.get("error_description");

			if (error) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(RESULT_PAGE(false, `${error}: ${errorDescription ?? "unknown"}`));
				reject(new OAuthFlowError(`OAuth provider returned error: ${error}`, "validation"));
				return;
			}
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(RESULT_PAGE(false, "No authorization code found in the callback request."));
				reject(new OAuthFlowError("No code in callback", "validation"));
				return;
			}
			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
				res.end(RESULT_PAGE(false, "OAuth state parameter mismatch (possible CSRF)."));
				reject(new OAuthFlowError("OAuth state mismatch", "validation"));
				return;
			}

			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(RESULT_PAGE(true, "Authentication code received. Finalizing login..."));
			resolve({ code, state });
		});

		server.once("error", rejServer);
		server.listen(port, hostname, () => resServer(server));
	});
}

export async function startCallbackServer(
	callbackPath: string,
	preferredPort: number,
	expectedState: string,
): Promise<CallbackHandle> {
	let resolveResult!: (r: { code: string; state: string }) => void;
	let rejectResult!: (e: Error) => void;
	const result = new Promise<{ code: string; state: string }>((res, rej) => {
		resolveResult = res;
		rejectResult = rej;
	});

	const servers: http.Server[] = [];
	let boundPort = preferredPort;

	try {
		const s = await serveCallback(
			"127.0.0.1",
			preferredPort,
			callbackPath,
			expectedState,
			resolveResult,
			rejectResult,
		);
		servers.push(s);
	} catch {
		const fallback = await serveCallback(
			"127.0.0.1",
			0,
			callbackPath,
			expectedState,
			resolveResult,
			rejectResult,
		);
		servers.push(fallback);
		const addr = fallback.address();
		if (addr && typeof addr === "object") boundPort = addr.port;
	}

	try {
		const v6 = await serveCallback(
			"::1",
			boundPort,
			callbackPath,
			expectedState,
			resolveResult,
			rejectResult,
		);
		servers.push(v6);
	} catch {
		// IPv6 bind is best-effort companion
	}

	return {
		port: boundPort,
		redirectUri: `http://127.0.0.1:${boundPort}${callbackPath}`,
		result,
		close: () => {
			for (const s of servers) {
				try {
					s.close();
				} catch {
					// Ignore close errors
				}
			}
		},
	};
}

export function parseCallbackInput(input: string): {
	code?: string;
	state?: string;
} {
	const trimmed = input.trim();
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		try {
			const url = new URL(trimmed);
			return {
				code: url.searchParams.get("code") ?? undefined,
				state: url.searchParams.get("state") ?? undefined,
			};
		} catch {
			// Fall through
		}
	}
	if (trimmed.includes("code=") || trimmed.includes("state=")) {
		const params = new URLSearchParams(trimmed.startsWith("?") ? trimmed.slice(1) : trimmed);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	if (/^[A-Za-z0-9_\-\/]+$/.test(trimmed)) {
		return { code: trimmed };
	}
	return {};
}

// ---------------------------------------------------------------------------
// Token exchange / refresh
// ---------------------------------------------------------------------------
