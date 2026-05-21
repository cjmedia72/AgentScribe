# Changelog

## [1.0.14] - 2026-05-20

### Added
- fetch-capture.js MAIN-world proxy for service-worker / PWA fetch + XHR (RISE hotfix)
- Page-context fetch/XHR interception that complements chrome.webRequest
- Pause/Stop buttons on the recording overlay (in-page controls)
- Auto-open extension popup on stop-from-overlay (chrome.action.openPopup with sessions-page fallback)
- Storage Debug panel on sessions page (auto-shows only on orphaned activeSession anomaly)
- activeSession recovery flow + "Recover into Completed" button
- "Migrate sessions to slim format" button for legacy bloated sessions
- 1MB per-event responseBody cap to prevent storage write hangs
- 8MB slim-at-write cap for enrichment arrays (bundleFindings/storageSnapshots/fetchEvents/wsFrames/wsConnections/cookieSnapshots)
- Outcome detection heuristic (success/failed/uncertain) with user-override pill on session cards
- inferOutcome export in correlation-engine.js with 8-signal scoring
- outcome / outcome_confidence / outcome_user_set fields in bundle exports
- New branded logo (orange+cream interlocking AS) for extension card + Chrome Web Store
- Split icon strategy: AS-square in toolbar (16px readability), new logo in extension card

### Fixed
- DOM event capture regression (Wave 3 wrap was eating startCapturing)
- Overlay paint delayed by wave3 async init — now paints instantly
- content.js not in tab after extension reload — programmatic injection added
- Stop-from-overlay popup race (60s delay) — popup now opens before stopRecording awaits
- Sessions page blank after stop-from-overlay — chrome.storage.onChanged auto-refresh
- Sessions page reads chrome.storage.local DIRECTLY (bypasses chrome.runtime.sendMessage 64MB IPC cap)
- Popup auto-refreshes when lastSession lands after stop (no more stale 10-15s gap)
- Dead-wired detectors (challenge layer, pagination, mutation) now properly invoked

## [1.0.13] - 2026-05-17

### Added
- chrome.cookies permission and cookie snapshot orchestration
- Multi-tab follow via chrome.tabs.onCreated
- storage-snapshot.js module (localStorage / sessionStorage / IndexedDB)
- auth-detector.js module with JWT decoding
- bundle-analyzer.js module for static JS analysis
- ws-capture.js MAIN-world proxy for WebSocket / EventSource frames
- Wave 3 integrations across content.js / background.js / correlation-engine.js / field-scanner.js
- All 5 exporters enriched with auth state + storage state + challenge layer + ws exchanges
- Playwright storageState injection (zero-F12 replay)
- Postman env var substitution + companion environment file
- SOP auth flow + hidden state + replay caveats sections
- MCP auth_state block + discovered_endpoints + pagination_strategies + semantic_endpoints + ws_exchanges
- Bundle orchestrator with cross-export consistency checks

### Fixed
- extraHeaders flag on webRequest listeners (cookies were being stripped pre-v1.0.13)

### Schema
- Additive — all v1.0.12 fields preserved
- New session-level arrays: cookieSnapshots, storageSnapshots, bundleFindings, wsConnections, wsFrames, tabsAttached
- New session-level objects: authProfile, challengeLayer
- New networkEvent fields: auth_classification, pagination, mutates_state
