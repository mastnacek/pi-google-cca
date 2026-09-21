# Google Cloud Code Assist & Antigravity OAuth for pi

Adds browser OAuth login and full support for Google Antigravity & Cloud Code Assist models to pi (`@earendil-works/pi-coding-agent`).

Supports **Gemini 3.x/2.5**, **Anthropic Claude (Sonnet 4.6, Opus 4.6, Sonnet 4.5, Opus 4.5)**, and **OpenAI GPT-OSS (120B)** through your Google subscription/OAuth grant, with dynamic model discovery, thinking config, and live quota tracking.

## Features

- **OAuth Authentication**:
  - `/login google` or `/login google-antigravity` runs browser authorization against Google.
  - Automatic loopback server (`127.0.0.1:51121` / `127.0.0.1:8085`) and manual code entry support.
  - Auto-provisioning for the Antigravity free tier (`onboardUser` + project discovery).
  - Background token refresh before expiry.
  - Subscription status marked with `isSubscription: true`.

- **All Antigravity Models Supported**:
  - **Gemini**: `gemini-3.7-flash`, `gemini-3.5-flash`, `gemini-3.1-pro`, `gemini-3-flash`, `gemini-3-pro`, `gemini-2.5-flash`, `gemini-2.5-pro`.
  - **Anthropic Claude via Antigravity**: `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-opus-4-5` (with 64,000 output token limit capping and `anthropic-beta: interleaved-thinking-2025-05-14` header).
  - **OpenAI GPT-OSS via Antigravity**: `gpt-oss-120b`.
  - **Dynamic Discovery**: Automatically discovers any newly released models via `/v1internal:fetchAvailableModels` and collapses effort-tier variants.

- **Wire-Format & Schema Normalization Fixes**:
  - Unsigned first function call sentinel (`skip_thought_signature_validator`) to prevent Gemini 3+ tool-calling errors.
  - Full proto JSON Schema normalization stripping `anyOf`, `oneOf`, `allOf`, `not`, `$schema`, `additionalProperties`, and `patternProperties` to avoid `INVALID_ARGUMENT: Cannot find field` errors.
  - System instructions sent with `role: "user"` as required by Antigravity.
  - Claude models automatically configure `VALIDATED` tool mode.
  - Multi-endpoint failover across `daily-cloudcode-pa.googleapis.com` and `daily-cloudcode-pa.sandbox.googleapis.com`.
  - Flash planning leak filter and thought-signature preservation across turns.

- **Live Quota & Rate-Limit Tracking**:
  - Statusline display showing 5-hour and weekly window capacities (e.g. `🪐 Antigravity: 5h 93% (4h27m) · Wk 77% (3d8h)`).
  - `/google-quota` command for detailed quota breakdown and reset countdowns.

## Usage

1. **Log in with your Google account**:
   ```bash
   /login google
   ```
   Choose **Antigravity** (for Gemini 3.x, Claude, and GPT-OSS models) or **Gemini CLI**.

2. **Select and use models**:
   ```bash
   /model gemini-3.7-flash
   /model claude-sonnet-4-6
   /model claude-opus-4-6
   /model gemini-3.1-pro
   /model gpt-oss-120b
   ```

3. **Check remaining quota**:
   ```bash
   /google-quota
   /google-quota refresh
   ```

## Files

- `extensions/index.ts` — Provider registration (`google` & `google-antigravity`), request building, SSE streaming, model catalog, and lifecycle hooks.
- `extensions/oauth.ts` — Google OAuth flow, PKCE callback server, dynamic Antigravity client versioning, project discovery, and token refresh.
- `extensions/google-wire.ts` — Wire-format message converters, thought signature preservation, and proto-backed JSON Schema normalization (`normalizeSchemaForCCA`).
- `extensions/quota.ts` — Antigravity quota discovery (`retrieveUserQuotaSummary`), statusline renderer, and `/google-quota` banner.
