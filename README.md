<div align="center">

<img src="docs/logo.png" alt="AgentScribe" width="160" />

# AgentScribe

**Record a browser workflow once. Hand the bundle to an agent. Automate forever.**

![Version](https://img.shields.io/badge/version-1.0.14-ef4444?style=flat-square)
![Manifest](https://img.shields.io/badge/manifest-v3-3b82f6?style=flat-square)
![Platform](https://img.shields.io/badge/Chrome%20%7C%20Edge%20%7C%20Brave-supported-22c55e?style=flat-square)
![Local](https://img.shields.io/badge/local--only-no%20telemetry-8b5cf6?style=flat-square)

</div>

---

## What it does

Chrome extension that records every layer of a browser session — DOM clicks and inputs, network requests with full headers/payloads/response bodies, cookies, localStorage, sessionStorage, IndexedDB, WebSocket frames, OAuth popups, anti-bot challenge layers, auth tokens, CSRF tokens, OTP fields — and packages it into a single artifact an agent can replay without ever opening DevTools.

```
1. Press Ctrl+Shift+R
2. Do the workflow (click, type, navigate)
3. Press Ctrl+Shift+R (or click ⏹ in overlay)
4. Export as Bundle
5. Paste into Claude Code / ChatGPT / Cursor / any agent
6. Agent has cookies + auth + endpoints + replay script
```

The agent doesn't need to F12 the platform anymore. The recording already did it.

---

## Capabilities (v1.0.14)

### What gets captured

| Layer | What's captured | How |
|---|---|---|
| **DOM events** | Every click, input, navigation, scroll, paste, keydown | Content script listeners |
| **Network** | XHR + Fetch + Document with full headers / payloads / response bodies | `chrome.debugger` CDP (primary) + `chrome.webRequest` (fallback) |
| **Page-context fetch / XHR** | Service-worker-routed and PWA-internal requests that webRequest misses | MAIN-world `window.fetch` + `XMLHttpRequest` proxy |
| **WebSocket / EventSource** | Connect URL, sub-protocols, every send/receive frame | MAIN-world constructor wrap |
| **Cookies** | Full metadata (name, value, domain, path, expiration, httpOnly, secure, sameSite) on start / each navigation / end | `chrome.cookies.getAll` |
| **localStorage / sessionStorage** | Full key/value dump on start + each navigation | Page-context snapshot |
| **IndexedDB** | Store metadata + key samples + schema | `indexedDB.databases()` enumeration |
| **Loaded JS bundle** | Static scan for API base URLs, endpoint string literals, refresh endpoints, GraphQL endpoints, HMAC signing functions (CryptoJS / SubtleCrypto / custom) | Regex pass over fetched script sources |
| **Form fields** | Every input with CSS selector + XPath + form action + POST param name | DOM scan + MutationObserver |
| **OAuth popups** | Auto-followed when opened from tracked tab | `chrome.tabs.onCreated` |

### What gets classified

| Classifier | Output |
|---|---|
| **Auth scheme** | `jwt-bearer` / `session-cookie` / `api-key` / `csrf` / `hmac-signed` / `oauth-bearer` / `custom` — per request and aggregated session-level |
| **JWT decode** | Auto-decoded `exp`, `iss`, `aud` — refresh schedule inferred |
| **Anti-bot layer** | Cloudflare Turnstile, PerimeterX, Akamai, hCaptcha, reCAPTCHA flagged |
| **OTP / 2FA fields** | Tagged `runtime_input_required: true` (recorded value will be expired at replay) |
| **CSRF source** | Header / cookie / hidden input / endpoint traced back |
| **Pagination cursor** | `nextPageToken`, `cursor`, `_next`, `after`, `continuation` detected in responses |
| **Mutating endpoints** | POST/PUT/PATCH/DELETE tagged `mutates_state: true` |
| **Workflow outcome** | Heuristic success/failed/uncertain with user-override pill on the session card |

### What gets exported

| Format | Use |
|---|---|
| **Raw JSON** | Source of truth — every event, every header, every snapshot |
| **Playwright** | Runnable `.js` script with `storageState` pre-injected (cookies + localStorage) for zero-F12 replay |
| **Postman** | Collection with `{{auth_token}}` / `{{csrf_token}}` env vars + companion environment file |
| **SOP** | Markdown runbook with auth-flow section, hidden-state section, replay caveats |
| **MCP** | Machine-readable config for an MCP server — `auth_state`, `discovered_endpoints`, `pagination_strategies`, `semantic_endpoints`, `ws_exchanges` |
| **Bundle** | All 6 in one JSON file, cross-checked for internal consistency, agent-instruction header included |
| **Clipboard shim** | ~9KB lean payload — pastes directly into Claude / GPT context without crashing on size |

---

## Install

```bash
git clone https://github.com/cjmedia72/AgentScribe
```

Then in Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right)
3. Click **Load unpacked**
4. Select the `AgentScribe` folder

For `cookies` permission to take effect, Chrome will prompt: *"AgentScribe now needs: Read and modify your cookies"* — accept. Required for the v1.0.13+ auth-state capture.

---

## Usage

### Hotkey

`Ctrl+Shift+R` (Windows / Linux) or `Cmd+Shift+R` (macOS) toggles recording on the active tab.

### Overlay controls

A small floating widget appears in the bottom-right of any page being recorded:

- **⏸** Pause recording (counter freezes, overlay turns amber)
- **⏹** Stop and auto-open extension popup
- **Live timer + event counter**

### Sessions page

Click the AgentScribe icon → **VIEW ALL SESSIONS**. Each saved session has:

- Preview button (👁) — timeline view of all captured events
- BUNDLE button — download the full JSON bundle
- Clipboard button (📋) — copy lean shim to clipboard for agent paste
- Per-format export buttons (JSON / PW / PM / SOP / MCP)
- Notes field — autosaves
- Outcome pill — heuristic success/failed/uncertain, click to override
- Delete

---

## Architecture

```
┌─────────────────┐    ┌────────────────────┐    ┌─────────────────┐
│ content.js +    │ ←→ │ background.js (SW) │ ←→ │ chrome.storage  │
│ MAIN-world      │    │                    │    │ .local          │
│ proxies         │    │ - CDP debugger     │    │                 │
│                 │    │ - webRequest       │    │ - sessions[]    │
│ - DOM events    │    │ - cookies API      │    │ - settings      │
│ - storage dump  │    │ - tabs.onCreated   │    │                 │
│ - bundle scan   │    │ - correlation      │    └─────────────────┘
│ - WS / fetch    │    │ - auth classifier  │            │
│ - field scan    │    │ - outcome detect   │            │
└─────────────────┘    └────────────────────┘            │
                                                          ↓
                                                  ┌───────────────┐
                                                  │ Sessions UI + │
                                                  │ Popup +       │
                                                  │ Exporters     │
                                                  └───────────────┘
```

Every capture layer runs in parallel. Correlation engine links DOM events to the network requests they triggered (1s window). At stop time: slim → persist → export.

---

## Privacy

- **No telemetry. No cloud. Everything runs local.**
- Sessions live in `chrome.storage.local` with `unlimitedStorage` permission.
- Exports go to your Downloads folder.
- Cookies, tokens, and storage are captured **raw** — that's the point.
- **Treat every bundle file like a credential.** Don't paste raw bundles into untrusted services. Don't commit them to public repos.
- Sensitive fields (password / credit card / SSN) auto-redact unless you flip the override toggle.
- Auth tokens and session cookies are NOT redacted by default — they're the captured value the agent needs.

---

## Known limitations

See [`docs/v1.0.13-known-gaps.md`](docs/v1.0.13-known-gaps.md) for the honest list.

Highlights:
- Anti-bot challenge layers (Cloudflare / PerimeterX / etc.) are **detected** but not bypassed — that's an ethical line. Agent gets warned, recommends stealth browser.
- OTP / 2FA codes require runtime user input (recorded value will be expired).
- Cross-origin iframe cookies aren't captured (chrome.cookies API limitation).
- IndexedDB capture is metadata-only — values not snapshotted (cap-limited values planned for v1.0.15).
- HMAC signing functions detected statically — obfuscated / WASM-based signers may not be found.

---

## Roadmap

See [`CHANGELOG.md`](CHANGELOG.md) for shipped versions.

**v1.0.15 candidates:**
- Auth-detector entropy ranking (better cookie picking on token-vs-counter conflicts)
- `fetchEvents` surfacing in MCP / Playwright / Postman exports
- IndexedDB value snapshot (cap-limited per store)
- OAuth pause-state propagation across followed tabs
- Module 08 outcome detection refinement (multi-signal scoring)

---

## Tech

Vanilla JavaScript, ES2022 modules, no build step, no npm. Chrome MV3.

| File | Role |
|---|---|
| `background.js` | Service worker — recording state, CDP, network capture, message routing |
| `content.js` | Content script — DOM event listeners, overlay UI, page-context proxy injection |
| `correlation-engine.js` | Links DOM events to triggered network calls, infers pagination + mutation + outcome |
| `auth-detector.js` | Classifies auth scheme per request, decodes JWTs |
| `bundle-analyzer.js` | Static scan of loaded JS for endpoints + signing functions |
| `storage-snapshot.js` | localStorage / sessionStorage / IndexedDB dump |
| `ws-capture.js` / `fetch-capture.js` | MAIN-world proxies |
| `field-scanner.js` | Form field enumeration + OTP / CSRF / anti-bot detection |
| `session-namer.js` | Inferred session name (hostname + datetime) |
| `exporters/` | 6 export formats (json / playwright / postman / sop / mcp / bundle) |
| `popup/` | Toolbar popup UI |
| `sessions/` | Sessions management page |
| `settings/` | Settings page |

---

## Source available

No license file. Source available for personal use. Built for [cjmedia72](https://github.com/cjmedia72).
