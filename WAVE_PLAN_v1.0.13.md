# AgentScribe v1.0.13 — Total Capture Hardening · Wave Plan

**Project**: AgentScribe Chrome extension at `C:/Users/CJ MEDIA/Documents/1. EXTENSIONS/AgentScribe`
**Current version**: `1.0.12` (manifest.json)
**Target version**: `1.0.13`
**Owner**: CJ · Sovereign
**Dispatcher**: devsm (parallel-dev-dispatch)
**Authored by**: MAX

---

## Goal

Close every auth/state-capture gap so a single recording produces a self-contained replay artifact. The downstream agent reads the exported JSON and replays the workflow with zero post-recording page interaction. No more "agent goes back to the page via MCP to F12 the cookies / inspect localStorage / decode the JWT / find the refresh endpoint."

---

## What AgentScribe currently is (do not change)

Chrome MV3 extension. Records active-tab workflows via `chrome.webRequest` + `chrome.debugger`. Exports in 6 formats: JSON · Playwright · Postman · SOP · MCP · Bundle. Ctrl+Shift+R toggles recording. Single-tab, single-session model.

Current file layout:
```
manifest.json
background.js          (27KB — service worker, network capture, session orchestration)
content.js             (17KB — DOM event capture, field scanner injection)
correlation-engine.js  (DOM→network 1s correlation window)
field-scanner.js       (form input enumeration, sensitive-field detection)
session-namer.js
overlay.js
exporters/
  json-exporter.js
  playwright-exporter.js
  postman-exporter.js
  sop-exporter.js
  mcp-exporter.js
  bundle-exporter.js
popup/  settings/  sessions/  icons/
```

Working contracts to preserve:
- Existing export formats remain readable by existing consumers (additive fields only)
- Ctrl+Shift+R hotkey unchanged
- Session JSON schema additive (new top-level keys, no removals/renames)

---

## Gap inventory — what's missing today vs what the agent currently has to do manually

| # | Manual step today | Root cause in AgentScribe | After v1.0.13 |
|---|---|---|---|
| 1 | F12 → Cookie header copy | webRequest registered without `'extraHeaders'` flag → Chrome strips `Cookie` before handler sees it | `'extraHeaders'` added · cookies in every captured request |
| 2 | F12 → Set-Cookie inspection | Same flag missing on `onResponseStarted` | Set-Cookie captured · diff'd across session |
| 3 | F12 → Application → localStorage | Not captured | localStorage dumped at session start + after each nav |
| 4 | F12 → Application → sessionStorage | Not captured | sessionStorage dumped same cadence |
| 5 | F12 → Application → IndexedDB | Not captured | IDB stores enumerated · per-store key snapshots |
| 6 | Eyeball headers · identify the auth one | All headers dumped, none classified | `auth-detector` classifies each: Cookie / Bearer / API-Key / CSRF / HMAC / Custom |
| 7 | Manually decode JWT to read exp | Not parsed | JWT auto-decoded · exp/iss/aud surfaced · refresh schedule inferred |
| 8 | Find refresh-token endpoint | Not inferred | Heuristic match: `/refresh`, `/token`, `/auth/renew` + 401 retry chains flagged |
| 9 | Find CSRF token + trace its source | Not classified | Detector traces token back to HTML meta / cookie / separate endpoint |
| 10 | Discover endpoints not clicked during recording | Only what was clicked is captured | `bundle-analyzer` scans loaded JS for API base URLs + endpoint string literals |
| 11 | Find HMAC signing function in JS bundle | Not done | Bundle analyzer finds `CryptoJS.HmacSHA*`, `crypto.subtle.sign`, custom signer patterns · extracts algorithm |
| 12 | WebSocket / SSE frame capture | Initial upgrade captured, frames lost | Page-context WebSocket / EventSource proxy · frame buffer |
| 13 | Identify pagination cursor | Not flagged | Response-shape inspector flags `nextPageToken` / `cursor` / `_next` / `after` |
| 14 | Tag mutating endpoints | Not tagged | Method + URL + response → `mutates_state: true/false` |
| 15 | Semantic labeling (what each endpoint does) | Generic `POST /api/v2/x` | DOM-context labeler: button text + form action → endpoint purpose |
| 16 | OAuth popup tab capture | Single-tab limitation | `chrome.tabs.onCreated` listener · popup auto-joins active session |
| 17 | 2FA / OTP field flagging | Redacted as generic sensitive | OTP detector: `autocomplete=one-time-code` / `name=otp` / 4-8 digit max-length → `runtime_input_required: true` |
| 18 | Anti-bot challenge detection | Records request, fails on replay | Detector flags CF turnstile / PerimeterX / Akamai · recommends stealth-browser path |
| 19 | Playwright storageState injection | `newContext()` empty | Full storageState injected (cookies + per-origin localStorage) |
| 20 | MCP export auth_state block | Absent | First-class field — agent reads and replays |
| 21 | Service Worker / fetch intercepts via fetch wrapper | Not seen by webRequest in some cases | Page-context fetch/XHR proxy via injected content script |

---

## Wave plan — 5 waves · 17 agents · DAG validated

### WAVE 1 — FOUNDATION
**Agents**: 1 sequential
**Files written**: `manifest.json`, `background.js` (foundation sections only)
**Blocks**: all downstream waves

| Agent | Task |
|---|---|
| `wave1-foundation` | (a) Bump manifest `version` to `1.0.13`. (b) Add `"cookies"` to manifest permissions. (c) Add `'extraHeaders'` to BOTH webRequest listeners (`onBeforeSendHeaders` + `onResponseStarted`). (d) Implement `chrome.cookies.getAll({ url })` snapshot orchestration — call on session start, on each navigation, on session end. Append to `sessionBuffer.cookieSnapshots[]`. (e) Add `chrome.tabs.onCreated` listener — when tab opens during active recording, auto-track it. Append to `sessionBuffer.tabsAttached[]`. (f) Smoke-test against a logged-in site, verify `Cookie` header appears in `session.networkEvents[*].headers` AND `cookieSnapshots[].cookies` is populated. |

**Acceptance**:
- `manifest.json` version reads `"1.0.13"`, includes `"cookies"` permission
- Session JSON has non-empty `cookieSnapshots[]` with full cookie metadata (name, value, domain, path, expirationDate, httpOnly, secure, sameSite)
- OAuth popup tab joins parent session automatically (verify via session JSON `tabsAttached[]`)
- `Cookie` and `Set-Cookie` headers present in captured network events

---

### WAVE 2 — CAPTURE MODULES
**Agents**: 4 parallel (all create NEW files — zero write conflicts)
**Files created**: 4 new modules in extension root

| Agent | New file | Responsibility |
|---|---|---|
| `wave2-storage-snapshot` | `storage-snapshot.js` | localStorage + sessionStorage full dump. IndexedDB enumeration via `indexedDB.databases()` then per-DB per-store cursor read. Exports `snapshotStorage()` → returns `{ localStorage: {...}, sessionStorage: {...}, indexedDB: [{ db, store, keys, sample }] }`. Snapshots invoked on session start + each navigation. |
| `wave2-auth-detector` | `auth-detector.js` | Pure-function classifier. Input: request headers + cookie jar + storage snapshots. Output: `{ auth_scheme: 'jwt-bearer'\|'session-cookie'\|'api-key'\|'csrf'\|'hmac-signed'\|'oauth-bearer'\|'custom', auth_value_source: 'header:Authorization'\|'cookie:_session_id'\|'localStorage:authToken'\|..., jwt_decoded: {...}, expires_at: epoch, refresh_endpoint_hint: '/auth/refresh', csrf_token_source: 'meta[name=csrf-token]'\|'cookie:_csrf'\|'endpoint:/csrf' }`. Detects: Bearer-JWT, Cookie-session, API-Key header (X-API-Key/X-Auth-Token patterns), HMAC-signed (X-Signature / Authorization scheme containing hash), CSRF tokens (X-CSRF-Token / X-XSRF-Token / _csrf headers), OAuth bearer flows. |
| `wave2-bundle-analyzer` | `bundle-analyzer.js` | Static analysis of loaded JS. Inputs: array of script URLs + inline script contents from page. Output: `{ api_base_urls: [...], discovered_endpoints: [{ method, url_pattern }], signing_functions: [{ name, algorithm, location }], refresh_endpoint_candidates: [...], graphql_endpoints: [...] }`. Regex pass for `https?://[^"']+/api/v\d+`, endpoint string literals, common signer names (`CryptoJS.HmacSHA256`, `crypto.subtle.sign`, custom HMAC patterns), refresh-token URLs. |
| `wave2-ws-capture` | `ws-capture.js` | Page-context proxy. Wraps `window.WebSocket` and `window.EventSource` constructors. Records: connect URL, sub-protocols, every send + receive frame with timestamp + direction + payload. Frames push via `window.postMessage` to content script → background → `sessionBuffer.wsFrames[]`. Must inject via `<script>` element with `world: 'MAIN'` content script directive (already MV3-compatible). |

**Parallel safety**: 4 distinct new files. No overlap.

**Acceptance per agent**: Module exports its API. 50-line unit test in `tests/wave2/<module>.test.js` covering happy path + edge cases. Test passes via simple node runner or Chrome test page.

---

### WAVE 3 — INTEGRATION
**Agents**: 4 parallel (each modifies ONE existing file — zero overlap)
**Files modified**: `content.js`, `background.js`, `correlation-engine.js`, `field-scanner.js`

| Agent | File modified | Responsibility |
|---|---|---|
| `wave3-content-integrate` | `content.js` | Import `storage-snapshot.js`. Inject `ws-capture.js` into page context via `world: 'MAIN'` script tag. Trigger `snapshotStorage()` on `DOMContentLoaded`, `pagehide`, and on each AgentScribe capture event. Run `bundle-analyzer.js` once per page on `load`. Pipe all outputs to background via `chrome.runtime.sendMessage`. |
| `wave3-background-integrate` | `background.js` | Import `auth-detector.js`. Wire `chrome.runtime.onMessage` handlers for storage snapshots + bundle findings + WS frames. Run `auth-detector` on each captured request → enrich `networkEvent.auth_classification`. Aggregate detector outputs → top-level `session.authProfile`. Aggregate bundle findings → `session.bundleFindings`. Aggregate storage → `session.storageSnapshots[]`. Aggregate WS → `session.wsFrames[]`. |
| `wave3-correlation-extend` | `correlation-engine.js` | Add WebSocket frame correlation — group frames into "exchanges" by direction + timing window. Add response-shape inspector — flag pagination cursors in response body (regex on `nextPageToken` / `cursor` / `_next` / `after` / `continuation`). Add mutation detector — tag method DELETE/POST/PUT/PATCH with `mutates_state: true` unless response body looks like a read (heuristic). |
| `wave3-field-extend` | `field-scanner.js` | Add OTP/2FA detector: input where `type=text` + `maxlength` 4-8 + (`autocomplete=one-time-code` OR `name`/`id`/`aria-label` matches `otp\|2fa\|code\|verify`). Tag `runtime_input_required: true` instead of just `isSensitive`. Add CSRF input detector: hidden inputs with `name=_csrf` / `name=authenticity_token` / `name=csrf_token` etc. Add anti-bot challenge detector: presence of CF turnstile iframe, PerimeterX `_pxhd` cookie, Akamai `_abck` cookie, hCaptcha iframe — set `session.challengeLayer = 'cloudflare'\|'perimeterx'\|'akamai'\|'hcaptcha'`. |

**Parallel safety**: 4 distinct existing files. Wave 1's background.js edits are committed before Wave 3 starts; Wave 3's background.js edits land in different sections (post-capture enrichment + message handlers).

**Acceptance**: Re-record the Wave 1 smoke-test session. Verify session JSON now contains: `authProfile`, `bundleFindings`, `storageSnapshots[]`, `wsFrames[]` (if applicable), correlated mutation tags, OTP/CSRF flags, `challengeLayer` (if applicable).

---

### WAVE 4 — EXPORT LAYER
**Agents**: 5 parallel (one per exporter — zero overlap)
**Files modified**: 5 files in `exporters/`

| Agent | File modified | New fields |
|---|---|---|
| `wave4-mcp-export` | `exporters/mcp-exporter.js` | Add top-level `auth_state` block: `{ cookies, localStorage, sessionStorage, indexedDB, classified_headers, auth_scheme, expires_at, refresh_policy }`. Add `discovered_endpoints[]` from bundle analyzer. Add `pagination_strategies{}` from correlation. Add `semantic_endpoints{}` from DOM-context labeling. Add `challenge_layer` field. Add `ws_exchanges[]` if applicable. |
| `wave4-playwright-export` | `exporters/playwright-exporter.js` | Inject `storageState` block into `browser.newContext({ storageState: { cookies, origins: [{ origin, localStorage }] } })`. Add 2FA breakpoint comment: `// PAUSE: 2FA required at step N — set process.env.OTP_CODE or pause for manual input`. Add anti-bot stealth comment block when `challengeLayer` detected: `// CHALLENGE LAYER: <name>. Bare Playwright will fail. Use playwright-extra with stealth plugin or recorded browser session.` |
| `wave4-postman-export` | `exporters/postman-exporter.js` | Replace literal auth values with environment variable references: `{{auth_token}}` / `{{csrf_token}}` / `{{session_cookie}}`. Generate companion environment file with redacted defaults. Add OAuth pre-request script template when OAuth flow detected. |
| `wave4-sop-export` | `exporters/sop-exporter.js` | Human-readable auth flow section: "Your session uses **<auth_scheme>**. The token lives in **<storage_location>**. It expires every **<N>** seconds. Refresh by calling **<endpoint>**." Include a "Hidden state captured" subsection listing cookies + localStorage keys + IndexedDB stores. Include "Replay caveats" subsection noting OTP/anti-bot/CSRF re-fetch needs. |
| `wave4-bundle-export` | `exporters/bundle-exporter.js` | Orchestrate all new fields across the combined bundle. Ensure all 6 exports stay internally consistent (e.g., the Playwright cookie list matches the Postman env vars matches the MCP auth_state). |

**Parallel safety**: 5 distinct files. Zero overlap.

**Acceptance**: Re-export the Wave 3 smoke-test session in all 6 formats. Verify:
- MCP export has populated `auth_state` block
- Playwright export injects `storageState` and runs (does NOT need to F12 anything on first replay)
- Postman export uses env vars not literals
- SOP export includes auth flow + hidden state section
- All 6 exports internally consistent

---

### WAVE 5 — VALIDATION + DOCS
**Agents**: 3 parallel (distinct scopes)
**Files modified**: `tests/e2e/`, `README.md`, `docs/v1.0.13-known-gaps.md`

| Agent | Responsibility |
|---|---|
| `wave5-e2e-test` | End-to-end test against a real-target platform (recommend: Walmart Seller Center dashboard — production CSRF, real cookies, real session state). Record one session covering: login state inspection + list 5 orders + view 1 order detail + update 1 listing. Re-import into a fresh Playwright browser via the generated `storageState`. Verify the replay completes all steps **without any post-recording page interaction**. Document any remaining manual steps. |
| `wave5-readme-update` | Update `README.md` with v1.0.13 capabilities. Add `CHANGELOG.md` entry. Document the new `auth_state` schema in `docs/auth-state-schema.md`. |
| `wave5-adversarial` | Run AgentScribe against a hard target — Cloudflare-protected site (Etsy seller dashboard recommended). Document where auto-capture still falls short. Surface the honest "what the agent still has to do" list in `docs/v1.0.13-known-gaps.md`. Specifically test: (a) anti-bot challenge re-trigger on replay, (b) OAuth multi-tab flow if site uses social login, (c) HMAC-signed requests if applicable. |

**Parallel safety**: 3 distinct file scopes. No overlap.

**Acceptance**:
- E2E replay against Walmart succeeds with zero F12 / zero MCP page interaction
- README + CHANGELOG updated
- Known-gaps doc lists any remaining manual steps honestly (no hand-waving)

---

## DAG check

```
WAVE 1 (manifest + background.js foundation)
   │
   ▼
WAVE 2 (4 new modules — parallel)         [storage / auth-detector / bundle / ws]
   │
   ▼
WAVE 3 (integrate into 4 existing files — parallel)  [content / background / correlation / field]
   │
   ▼
WAVE 4 (5 exporters — parallel)           [mcp / playwright / postman / sop / bundle]
   │
   ▼
WAVE 5 (e2e + docs — parallel)            [e2e / readme / adversarial]
```

**Cycle count**: 0
**Within-wave write conflicts**: 0 (file-disjoint per agent)
**Cross-wave conflicts**: Wave 1 → Wave 3 both touch background.js — Wave 3 rebases against Wave 1 result. devsm enforces.
**Total agents**: 17
**Total waves**: 5

---

## Out of scope (intentional — flag for future versions)

- **Diffusion / image generation** — separate lane, unrelated
- **MCP server wrapping AgentScribe** — would let Pattern OS constructs ingest sessions natively · flag for v1.0.14 or v1.1.0
- **In-extension replay engine** — keep replay outside the recorder, export and run via Playwright
- **Active anti-bot bypass** — DO NOT attempt. Detect, surface, recommend stealth-browser path. CF / PerimeterX bypass is legally and ethically off-limits.
- **Service Worker network interception** for sites using SW fetch handlers — partial coverage via page-context fetch proxy in Wave 2; full SW interception flag for v1.0.14
- **Mobile / iframe / cross-origin worker capture** — flag for v1.0.14

---

## Pre-flight (governance)

- **fpswm Step-1 consult**: recommended before dispatch — 60-second check on whether gap inventory is RIGHT inventory (vs over-engineering). Not blocking.
- **Tier change**: NO (stays T2 utility extension)
- **Composability**: existing exporter contracts preserved (additive-only fields)
- **Source citations**: this brief + AgentScribe current code + Andrew "Connecting Platforms" transcript module 04 (in vault at `whop_test/vault/04__connecting-platforms/`)

---

## Dispatch instructions for devsm

```
1. Read this file: AgentScribe/WAVE_PLAN_v1.0.13.md
2. Confirm DAG (0 cycles, 0 write conflicts within waves)
3. Optional: convene fpswm Step-1 challenge on gap inventory
4. Dispatch Wave 1 (1 agent, sequential)
5. After Wave 1 acceptance verified, dispatch Wave 2 (4 agents, parallel)
6. After Wave 2 acceptance verified, dispatch Wave 3 (4 agents, parallel)
7. After Wave 3 acceptance verified, dispatch Wave 4 (5 agents, parallel)
8. After Wave 4 acceptance verified, dispatch Wave 5 (3 agents, parallel)
9. Final: commit on `agentscribe-v1.0.13` branch, surface PR to CJ for review
```

---

**End of plan. Hand to devsm dispatcher in the AgentScribe chat session.**
