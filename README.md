# AgentScribe

Chrome extension that records browser workflows — DOM interactions, network calls, form fields, hidden state — and exports a self-contained replay artifact in 5 formats plus a combined bundle. Hand the bundle to an agent and it can replay the workflow without going back to the page.

## What it does

Press `Ctrl+Shift+R` on any tab. AgentScribe records every click, form input, navigation, network request, response, cookie, storage write, and WebSocket frame until you press the hotkey again. Export the session as JSON, Playwright script, Postman collection, SOP markdown, MCP server config, or all-of-the-above bundle. The agent reads the export and replays.

## v1.0.13 — Total Capture (NEW)

- **Cookie snapshot** at session start, on each navigation, and at session end — full metadata (name, value, domain, path, expiration, httpOnly, secure, sameSite).
- **localStorage / sessionStorage / IndexedDB** dump on session start and after each navigation — full key/value for LS/SS, store + key metadata for IDB.
- **WebSocket / EventSource frame capture** via MAIN-world proxy — connect URL, sub-protocols, every send/receive frame with timestamp and direction.
- **Bundle analyzer** — static scan of loaded JS for API base URLs, endpoint string literals, refresh-token endpoints, GraphQL endpoints, HMAC signing functions (CryptoJS, SubtleCrypto, custom signers).
- **Auth classifier** — every captured request tagged with `jwt-bearer` / `session-cookie` / `api-key` / `csrf` / `hmac-signed` / `oauth-bearer` / `custom`. JWTs auto-decoded for `exp` / `iss` / `aud`.
- **Anti-bot challenge layer detection** — Cloudflare Turnstile, PerimeterX, Akamai, hCaptcha, reCAPTCHA flagged at session level so the agent knows replay needs a stealth browser.
- **OTP / 2FA field detection** — fields with `autocomplete=one-time-code`, 4-8 digit codes, or `otp`/`2fa`/`verify` names tagged `runtime_input_required: true` instead of generic sensitive.
- **Multi-tab follow** — `chrome.tabs.onCreated` listener attaches OAuth popups and any new tab opened during recording to the active session.
- **Playwright export** now injects `storageState` (cookies + per-origin localStorage) for zero-F12 replay.
- **Postman export** now uses environment variables (`{{auth_token}}`, `{{csrf_token}}`, `{{session_cookie}}`) and ships a companion environment file.
- **SOP export** now includes an auth flow section ("your session uses X, token lives in Y, expires in Z"), a hidden state section listing all captured cookies / storage keys / IDB stores, and a replay caveats section.
- **MCP export** adds a top-level `auth_state` block — see `docs/auth-state-schema.md`.

## Install

1. Clone or download this repo.
2. Open `chrome://extensions`.
3. Toggle Developer mode on.
4. Click "Load unpacked" and select the AgentScribe folder.

## Hotkey

`Ctrl+Shift+R` toggles recording on the active tab. (`Cmd+Shift+R` on macOS.)

## Quick start

1. Open the page you want to record.
2. Press `Ctrl+Shift+R` to start.
3. Do the workflow — click, type, navigate.
4. Press `Ctrl+Shift+R` to stop.
5. Open the AgentScribe popup, pick a session, export as Bundle.
6. Paste the bundle into your agent's context. The agent now has cookies, localStorage, classified auth headers, discovered endpoints, and a replay-ready Playwright script.

## Export formats

| Format | One-liner |
|---|---|
| **JSON** | Full raw session — every event, every header, every storage snapshot. The source of truth. |
| **Playwright** | Runnable `.js` script with `storageState` pre-injected. Replays the workflow in a fresh browser. |
| **Postman** | Importable collection with env-var-templated auth + companion environment file. |
| **SOP** | Markdown runbook for a human (or LLM) — steps, auth flow, hidden state, replay caveats. |
| **MCP** | Machine-readable config for an MCP server — `auth_state`, `discovered_endpoints`, `pagination_strategies`, `semantic_endpoints`, `ws_exchanges`. |
| **Bundle** | All 5 in one zip, cross-checked for internal consistency. |

## Privacy / Security

- No telemetry. No cloud. Everything runs local — sessions live in `chrome.storage.local` and exports go to your downloads folder.
- Cookies, tokens, and storage are captured **raw**. Treat any AgentScribe export like a credential. Don't paste it into untrusted contexts. Don't commit it to a public repo.
- Sensitive fields (password, credit card, SSN) are auto-redacted unless you flip the override toggle in settings. Auth tokens and cookies are NOT redacted by default — that's the point of the tool.

## Known limitations

See `docs/v1.0.13-known-gaps.md` for the honest list of what still needs human input on replay (anti-bot challenges, OTP codes, OAuth popups against some IdPs, etc.).

## Source available

No license file. Source available for personal use.

## Author

cjmedia72
