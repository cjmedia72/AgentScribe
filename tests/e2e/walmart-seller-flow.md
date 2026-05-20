# E2E Test Plan — Walmart Seller Center · AgentScribe v1.0.13

**Target**: AgentScribe v1.0.13 acceptance gate (Wave 5)
**Test surface**: Walmart Seller Center (https://sellercenter.walmart.com) — production CSRF, real session cookies, real storage state
**Owner**: CJ
**Last revised**: against v1.0.13 schema

This is a **manual e2e plan**. CJ executes it against a live, logged-in Walmart Seller account. The companion script `verify-bundle.mjs` automates the post-recording assertions.

---

## 0 — Pre-test setup

### 0.1 Install extension v1.0.13

1. Confirm `manifest.json` `version` reads `"1.0.13"`.
2. `chrome://extensions` → enable Developer mode → "Load unpacked" → select `C:/Users/CJ MEDIA/Documents/1. EXTENSIONS/AgentScribe`.
3. Confirm the AS toolbar icon appears.
4. Pin the extension so the popup is reachable.

### 0.2 Log into Walmart Seller Center manually

1. Open https://sellercenter.walmart.com in a regular Chrome tab (NOT incognito — extensions are usually off there).
2. Complete login including any 2FA. Do this **before recording** so the auth flow we're testing is the steady-state session, not the login itself.
3. Confirm the dashboard loads — top-right shows seller name.

### 0.3 Confirm extension is armed

1. Click the AS icon. Popup should show "Ready to record".
2. Confirm overlay badge appears on the page (check upper-right corner).
3. Settings → confirm v1.0.13 capture modules are listed (storage-snapshot · auth-detector · bundle-analyzer · ws-capture).

### 0.4 Clear any prior session buffer

If a prior session is open, close it from the popup. We want a clean record.

---

## 1 — Recording phase

Start recording: `Ctrl+Shift+R` (or AS popup → Start). Overlay badge should turn red/active.

| # | Action | Expected capture |
|---|---|---|
| 1 | Land on dashboard (already there from setup) | `storageSnapshots[0]` populated with localStorage + sessionStorage. `cookieSnapshots[0]` populated. Bundle analyzer fires once on `load` → `bundleFindings.api_base_urls[]` non-empty (expect `sellercenter.walmart.com/api/...`). |
| 2 | Navigate to **Orders** in left nav | New `cookieSnapshots[]` entry on navigation. `storageSnapshots[]` entry on `DOMContentLoaded`. Network events for the orders-list endpoint(s). |
| 3 | Confirm at least 5 orders are visible. Note the first order ID. | `networkEvents[]` includes the orders-fetch GET. `auth_classification.auth_scheme` populated on this request. `replay_hints.requires_csrf_refresh` set if CSRF token used. |
| 4 | Click into 1 order (the first one) | Network events for order-detail GET. New navigation → new storage + cookie snapshot. |
| 5 | Back out, go to **Listings** (or "Items") | More network events. Likely a different API base path. |
| 6 | Pick 1 listing → open editor → change price by $0.01 (or toggle some inventory flag) → save | Network events for listing-update POST/PUT/PATCH. This is the **mutating endpoint** — must be tagged `mutates_state: true`. CSRF header must be present and captured. |
| 7 | Confirm save succeeded (UI shows success toast or refreshed value) | Response captured. |

Stop recording: `Ctrl+Shift+R` again. Overlay should clear.

**Recording sanity check before export**:
- AS popup → session list → newest session has non-zero event count.
- Open the session detail view → confirm timeline shows all 7 steps.

---

## 2 — Export phase

From the session detail page in the AS popup:

1. Click **Export → Bundle (JSON)**. File lands in your default downloads folder, typically:
   `C:/Users/CJ MEDIA/Downloads/AgentScribe/sessions/walmart-seller-<timestamp>.bundle.json`
2. Click **Export → Playwright**. File lands as `walmart-seller-<timestamp>.spec.js` (or `.spec.ts`) in the same folder.
3. Note both paths.

The Bundle JSON is the artifact we verify. The Playwright script is what we replay.

---

## 3 — Verification phase (automated)

Run the companion script:

```bash
node "C:/Users/CJ MEDIA/Documents/1. EXTENSIONS/AgentScribe/tests/e2e/verify-bundle.mjs" "C:/Users/CJ MEDIA/Downloads/AgentScribe/sessions/walmart-seller-<timestamp>.bundle.json"
```

Exit code 0 = all assertions passed. Exit code 1 = something failed; per-assertion log will show which.

### What the script asserts (mirrors the manual checks below — run the script first, then eyeball if any fail)

| Assertion | Where in bundle | Why it matters |
|---|---|---|
| `_meta.schema === 'agentscribe-bundle'` | top-level | Confirms this is a v1.0.13 bundle, not legacy. |
| `raw_session.cookieSnapshots.length >= 1` | `raw_session.cookieSnapshots` | Wave 1 captures cookies; must have at least 3 for Walmart (login + nav + nav). Script asserts >= 1 defensively; manual check asserts >= 3. |
| `raw_session.storageSnapshots.length >= 1` | `raw_session.storageSnapshots` | Wave 2 storage-snapshot module fires. localStorage must have entries (Walmart stores session-context keys there). |
| `auth_profile` key exists | top-level | Wave 3 auth-detector aggregation. May be null if undetected — key presence is the contract. |
| `auth_profile.auth_scheme` populated | top-level | Manual check: should be `'session-cookie'` for Walmart (Walmart uses cookie-session + CSRF). If `'jwt-bearer'`, the JWT must decode. |
| `replay_hints` exists with 4 expected keys | top-level | The agent-facing hints block. Keys: `requires_csrf_refresh`, `requires_otp`, `challenge_layer`, `replay_strategy` (or equivalent v1.0.13 names — adjust if schema settled differently). |
| `replay_hints.requires_csrf_refresh === true` | top-level | Walmart uses CSRF on mutations — must be flagged. |
| All 5 exports present | `exports.{json,playwright,postman,sop,mcp}` | Wave 4 fan-out. Bundle export orchestrates all five. |
| `exports.playwright.storageState.cookies` is an array | exports | Wave 4 Playwright injection — cookies must be there or replay fails. |
| `networkEvents[]` has at least one POST or PUT | `raw_session.networkEvents` | Step 6 (mutating save) must be captured. |
| Each authed network event has `auth_classification.auth_scheme` | `raw_session.networkEvents[*]` | Wave 3 background-integrate enriches every event. |

### Manual eyeball checks (in addition to the script)

Open the bundle JSON in an editor (it should be human-readable, formatted). Grep for:

```
"auth_scheme"
"requires_csrf_refresh"
"cookieSnapshots"
"storageState"
"mutates_state"
"challenge_layer"
```

Each should resolve to populated values.

---

## 4 — Replay phase

This is the acceptance gate. The exported Playwright script must replay the workflow with **zero post-recording page interaction** — no F12, no manual cookie injection, no MCP-driven inspection.

### 4.1 Set up a clean Playwright runner

In a fresh terminal:

```bash
mkdir -p /tmp/agentscribe-replay
cp "C:/Users/CJ MEDIA/Downloads/AgentScribe/sessions/walmart-seller-<timestamp>.spec.js" /tmp/agentscribe-replay/
cd /tmp/agentscribe-replay
npm init -y
npm install --save-dev @playwright/test
npx playwright install chromium
```

### 4.2 Run the script

```bash
npx playwright test walmart-seller-<timestamp>.spec.js --headed
```

`--headed` so we can watch. Drop it for headless once we trust it.

### 4.3 Assert during replay

While the headed browser runs:

1. **Login state**: the browser should land on the dashboard **already logged in**. No login form. No 2FA prompt. If you see the login page, the `storageState` injection failed — FAIL.
2. **Orders list**: should fetch and display orders. The script should NOT need to type credentials.
3. **Order detail**: should open the same order ID we recorded.
4. **Listing update**: should reach the editor and submit the same change.

The replay does NOT need to land on the exact same DOM state — Walmart's UI is dynamic. But it MUST authenticate without the user touching the page.

---

## 5 — Pass/fail criteria

### PASS — all of these:

- [ ] Bundle JSON `_meta.schema === 'agentscribe-bundle'`
- [ ] `raw_session.cookieSnapshots.length >= 3`
- [ ] `raw_session.storageSnapshots[].localStorage` has at least one populated entry
- [ ] `auth_profile.auth_scheme` is non-null (likely `'session-cookie'`)
- [ ] `replay_hints.requires_csrf_refresh === true`
- [ ] At least one `networkEvents[]` entry has method POST or PUT
- [ ] Every authed network event has `auth_classification.auth_scheme` populated
- [ ] `exports.playwright.storageState.cookies` is a non-empty array
- [ ] All 5 exports present in `exports.{json,playwright,postman,sop,mcp}`
- [ ] Playwright replay reaches the dashboard logged in WITHOUT any manual cookie injection
- [ ] Playwright replay successfully fetches orders and opens order detail
- [ ] `node tests/e2e/verify-bundle.mjs <bundle>` exits 0

### FAIL modes — per assertion:

| Assertion fails | Likely cause | Where to look |
|---|---|---|
| `_meta.schema` missing or wrong | Bundle exporter not updated for v1.0.13 | `exporters/bundle-exporter.js` Wave 4 |
| `cookieSnapshots` empty | `extraHeaders` flag missing OR cookies permission missing | `manifest.json` + `background.js` Wave 1 |
| `storageSnapshots` empty | `storage-snapshot.js` not invoked on nav | `content.js` Wave 3 integration |
| `auth_profile` key missing | `auth-detector.js` not aggregated into session | `background.js` Wave 3 integration |
| `auth_scheme` null | Detector did not match any pattern — check Walmart actually uses session-cookie OR detector heuristic missed it | `auth-detector.js` Wave 2 |
| `requires_csrf_refresh` not true | CSRF detection missed | `auth-detector.js` + `field-scanner.js` Wave 3 |
| No POST/PUT in network events | `extraHeaders` flag missing OR step 6 didn't actually save | `background.js` Wave 1 + repeat step 6 |
| `exports.playwright.storageState` missing | Playwright exporter not updated | `exporters/playwright-exporter.js` Wave 4 |
| Replay shows login page (not dashboard) | `storageState` malformed OR cookies not domain-scoped correctly | Playwright exporter `storageState` block |
| Replay fails at CSRF-protected mutation | CSRF token expired during recording-to-replay gap OR token-refresh hint missing | Expected — see Known Limitations below |

---

## 6 — Known limitations (expected, not bugs)

1. **CSRF token expiry**: Walmart's CSRF tokens may expire between recording and replay. If the mutating step (listing update) fails on replay with a 403/CSRF error, this is the **`requires_csrf_refresh` hint** doing its job — the agent must re-fetch the token. Replay framework would handle this; bare Playwright with a stale token will fail. NOT a v1.0.13 bug.

2. **Aggressive replay → anti-bot re-trigger**: If you run the replay 5+ times in quick succession from the same IP, Walmart's bot detection may flag you and serve a challenge page. AgentScribe v1.0.13 detects challenge layers but does NOT bypass them. Wait, change IP, or use a stealth-browser variant.

3. **OAuth multi-tab flow not tested in this scenario**: Walmart Seller login is single-tab cookie-session, not OAuth popup. The `chrome.tabs.onCreated` listener from Wave 1 is exercised in the `wave5-adversarial` Etsy run, not here.

4. **Session expiry mid-replay**: If the recorded session is more than ~hours old, the cookie may be expired server-side. Re-record before replay if too much time has passed.

5. **UI dynamism**: Walmart's dashboard re-renders order rows on each load. Replay assertions should target API responses (which we captured), not DOM selectors (which drift).

6. **Headless detection**: Walmart may serve a different page in headless mode. Use `--headed` if anomalies appear; this is an environment limitation, not v1.0.13.

---

## 7 — When to re-run this test

- Any change to `background.js`, `content.js`, `manifest.json`, or any file in `exporters/`
- Any schema change to the bundle JSON
- Before tagging v1.0.13 final
- Before any v1.0.13.x patch ships

---

**End of plan.**
