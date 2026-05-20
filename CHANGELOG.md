# Changelog

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
