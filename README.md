# Google Cloud Code Assist OAuth for pi

Adds omp-style browser OAuth login to pi's built-in **`google`** provider.
No models are registered — pi's own google catalog (gemini-2.5-flash,
gemini-3.7-flash, …) is kept exactly as-is; only authentication and streaming
are replaced.

## What it does

- `/login google` runs the same flow as the omp CLI (ported from
  `oh-my-pi/packages/ai/src/registry/oauth/`):
  1. Client picker: **Antigravity** (`daily-cloudcode-pa.googleapis.com`,
     newest Gemini models) or **Gemini CLI** (`cloudcode-pa.googleapis.com`).
  2. Browser authorization-code flow against Google, received by a loopback
     callback server (`127.0.0.1:8085` / `:51121`, dual-stack, random-port
     fallback, CSRF state, 5-minute wait). `access_type=offline` +
     `prompt=consent` guarantee a refresh token.
  3. Token exchange → account email → Cloud Code Assist project discovery
     (`loadCodeAssist` / `onboardUser` + LRO polling, free-tier provisioning).
- Requests stream through the Cloud Code Assist wire protocol
  (`POST {endpoint}/v1internal:streamGenerateContent?alt=sse`, `{project,
  model, request}` envelope) with the OAuth access token instead of the
  Generative Language API + API key. Antigravity requests carry the real hub
  client's envelope (sessionId, requestId, labels, effort-routed wire model
  ids, `VALIDATED` tool mode, fixed output caps).
- Tokens refresh automatically before expiry (`oauth.refreshToken` hook); the
  grant's client variant and Cloud project id persist in
  `~/.pi/agent/auth.json`.
- Tool schemas are normalized for the proto-backed wire schema (port of omp's
  `normalizeSchemaForGoogle` subset) so MCP tool annotations (`deprecated`,
  `$defs`, validation keywords, non-string enums) don't 400 the request.
- Gemini-Flash planning-leak guard and thought-signature retention are ported
  from omp's google-gemini-cli provider.

## Usage

```bash
/login google        # browser OAuth; pick Antigravity or Gemini CLI client
--provider google --model gemini-3.7-flash ...
```

Note: after `/login google`, the stored OAuth credential replaces any AI
Studio API key for the `google` provider, and all google-provider traffic goes
through Cloud Code Assist. To go back to an API key, remove the `google` entry
from `~/.pi/agent/auth.json` and restart pi.

## Files

- `index.ts` — provider override (`registerProvider("google", { oauth, streamSimple })`)
- `oauth.ts` — login/refresh flows, callback server, project discovery
- `google-wire.ts` — message/tool converters + wire-schema normalization
