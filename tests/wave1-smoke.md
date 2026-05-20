# Wave 1 Smoke Test — v1.0.13 Foundation

**Scope**: verify manifest bump, cookies permission, `extraHeaders` flag, cookie snapshot orchestration, and multi-tab follow with `tabsAttached[]`. Manual test — do not automate yet.

## Prereqs

- Chrome with the unpacked AgentScribe extension loaded from `C:/Users/CJ MEDIA/Documents/1. EXTENSIONS/AgentScribe`
- A logged-in account on any site that sets cookies (GitHub, Gmail, Walmart Seller Center, Amazon Seller Central — anything that issues `Cookie` headers on XHR)
- Optional: a site with an OAuth popup (sign-in-with-Google flow) for the multi-tab test

## Pre-flight check (no recording yet)

1. Open `chrome://extensions` → confirm AgentScribe version reads **1.0.13**
2. Click "Details" → confirm "Read and modify your data on websites" includes cookies access (cookies permission active)

## Test 1 — Cookie snapshot + Cookie header capture

1. Navigate to a logged-in site (the tab must already have cookies)
2. Press `Ctrl+Shift+R` to start recording
3. Click around enough to trigger at least one in-page navigation (a link, not just an XHR)
4. Press `Ctrl+Shift+R` to stop
5. Open AgentScribe popup → Sessions → export the latest session as JSON
6. Open the JSON file and verify:

   **a. `cookieSnapshots[]` has at least 2 entries** (start + navigation; 3 if end-tab URL was reachable):
   ```
   session.cookieSnapshots.length >= 2
   ```

   **b. Each snapshot has the full structure:**
   ```
   {
     timestamp: <epoch ms>,
     url: "<page URL>",
     trigger: "start" | "navigation" | "end",
     cookies: [
       {
         name, value, domain, path,
         expirationDate, httpOnly, secure, sameSite,
         hostOnly, session, storeId
       }, ...
     ]
   }
   ```
   At least one cookie in `cookies[]` per snapshot for the logged-in domain.

   **c. `networkEvents[*].headers` contains a `Cookie` header** for at least one same-origin XHR/Fetch request. Without the `extraHeaders` flag this header would be stripped — its presence is the smoking gun that step (c) worked. Look in particular at the webRequest-source events (those populated by `onSendHeaders`):
   ```
   session.networkEvents
     .filter(e => e.source === 'webRequest' || e.source === 'cdp')
     .some(e => Object.keys(e.headers || {}).some(k => k.toLowerCase() === 'cookie'))
   ```

   **d. `Set-Cookie` header in at least one response** (if the site rotated a session cookie during the run):
   ```
   session.networkEvents
     .some(e => Object.keys(e.responseHeaders || {}).some(k => k.toLowerCase() === 'set-cookie'))
   ```
   Note: not every recording will see a Set-Cookie. Force one by logging out + logging back in mid-recording if needed.

## Test 2 — Multi-tab follow (OAuth popup)

1. Start recording on a site that has a Google/social sign-in button (or a site that opens a payment popup)
2. Click the sign-in / pay-now button — let it open the secondary tab
3. Complete the popup flow (or just let it load and close it)
4. Stop recording, export JSON
5. Verify:

   **a. `tabsAttached[]` has at least 2 entries:**
   ```
   session.tabsAttached.length >= 2
   ```
   First entry = original tab id, additional entries = popup/redirect tab ids.

   **b. `tabIds[]` matches** (existing field, should also include the popup tab — pre-existing behavior, just confirming nothing regressed):
   ```
   session.tabIds.length >= 2
   ```

   **c. `networkEvents[]` contains requests from the popup tab** (filter by `tabId !== originalTab`):
   ```
   const otherTabs = session.tabsAttached.filter(t => t !== session.tabIds[0]);
   session.networkEvents.some(e => otherTabs.includes(e.tabId))
   ```

## Pass criteria

All four assertions in Test 1 (a/b/c — d is best-effort) AND Test 2 (a/b/c if popup flow was exercised). If no OAuth flow was available, Test 2 may be skipped; document that.

## Failure modes to watch for

- `cookieSnapshots[]` missing entirely → `cookies` permission not granted, or `recordCookieSnapshot` not wired into start/nav/stop
- `cookieSnapshots[]` present but `cookies: []` empty for every snapshot → `chrome.cookies.getAll({ url })` returning empty (URL might be `chrome://` or `about:blank` at snapshot time)
- `Cookie` header absent in `networkEvents[*].headers` → `extraHeaders` flag did NOT take effect; double-check listener registration
- `tabsAttached` field absent → session schema not updated, or the popup didn't have `openerTabId` set (rare but possible for `window.open` with `noopener`)

## Out of scope for Wave 1

Storage snapshots (localStorage / sessionStorage / IndexedDB), auth classification, bundle analysis, WebSocket frames — those land in Waves 2-3.
