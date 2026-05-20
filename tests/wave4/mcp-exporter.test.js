// mcp-exporter.test.js
// Wave 4 unit tests for exporters/mcp-exporter.js
// Run: node tests/wave4/mcp-exporter.test.js
//
// Covers:
//   1. Empty-session export (defensive baseline)
//   2. Full-session export with every new v1.0.13 block populated
//   3. Missing-authProfile defensive case
//   4. Schema additivity — every v1.0.12 field still present
//   5. Section isolation — one broken section does not nuke siblings

import { exportMCP } from '../../exporters/mcp-exporter.js';

let passed = 0;
let failed = 0;
const fails = [];

function assert(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    fails.push(label);
    console.error('  FAIL:', label);
  }
}

function parse(result) {
  return JSON.parse(result.content);
}

// ---------------------------------------------------------------------------
// Helpers — fixtures
// ---------------------------------------------------------------------------

function emptySession() {
  return {
    id: 'sess-empty',
    startTime: 1700000000000,
    startUrl: 'https://example.com',
    events: [],
    networkEvents: [],
    injectableFields: []
  };
}

function fullSession() {
  return {
    id: 'sess-full',
    startTime: 1700000000000,
    startUrl: 'https://app.example.com',
    challengeLayer: 'cloudflare',

    events: [
      {
        id: 'evt-1',
        type: 'navigation',
        url: 'https://app.example.com/orders',
        timestamp: 1700000001000
      },
      {
        id: 'evt-2',
        type: 'click',
        url: 'https://app.example.com/orders/new',
        timestamp: 1700000002000,
        element: {
          text: 'Submit order',
          ariaLabel: 'Submit order',
          cssSelector: 'button#submit-order',
          xpath: '//button[@id="submit-order"]',
          tag: 'button'
        },
        triggeredRequests: [
          {
            requestId: 'req-1',
            method: 'POST',
            url: 'https://app.example.com/api/v2/orders/create',
            postData: '{"sku":"abc"}',
            responseStatus: 201,
            isPrimary: true
          }
        ]
      }
    ],

    networkEvents: [
      {
        requestId: 'req-1',
        method: 'POST',
        url: 'https://app.example.com/api/v2/orders/create',
        postDataParsed: { sku: 'abc' },
        responseStatus: 201,
        correlatedToDomEventId: 'evt-2',
        auth_classification: {
          classified_headers: [
            { name: 'Authorization', kind: 'bearer-jwt', metadata: { scheme: 'Bearer' } }
          ]
        }
      },
      {
        requestId: 'req-2',
        method: 'GET',
        url: 'https://app.example.com/api/v2/orders?page=1',
        responseStatus: 200,
        correlatedToDomEventId: null,
        pagination: {
          has_pagination: true,
          scheme: 'cursor',
          cursor_field: 'nextPageToken',
          cursor_value_example: 'cursor-xyz'
        }
      }
    ],

    injectableFields: [
      {
        name: 'sku',
        cssSelector: 'input[name="sku"]',
        xpath: '//input[@name="sku"]',
        postParamName: 'sku',
        formAction: '/api/v2/orders/create',
        formMethod: 'POST',
        purposeInferred: 'product-sku',
        isSensitive: false
      }
    ],

    // Wave 1 — cookie snapshots
    cookieSnapshots: [
      {
        timestamp: 1700000000000,
        cookies: [{ name: 'session_id', value: 'abc-OLD', domain: '.example.com' }]
      },
      {
        timestamp: 1700000005000,
        cookies: [{ name: 'session_id', value: 'abc-NEW', domain: '.example.com', httpOnly: true }]
      }
    ],

    // Wave 3 — storage snapshots
    storageSnapshots: [
      {
        timestamp: 1700000005000,
        localStorage: { authToken: 'tok-1', theme: 'dark' },
        sessionStorage: { tabId: 'tab-7' },
        indexedDB: [
          { db: 'app-db', store: 'orders', keys: ['k1', 'k2', 'k3'], sample: { id: 1 } }
        ]
      }
    ],

    // Wave 3 — bundle findings
    bundleFindings: [
      {
        discovered_endpoints: [
          { method: 'POST', url_pattern: '/api/v2/orders/:id', source: 'bundle_analysis', confidence: 0.8 },
          { method: 'GET', url_pattern: '/api/v2/orders', source: 'bundle_analysis', confidence: 0.9 }
        ]
      },
      {
        discovered_endpoints: [
          // Duplicate of above — should dedupe
          { method: 'POST', url_pattern: '/api/v2/orders/:id', source: 'bundle_analysis', confidence: 0.8 },
          { method: 'DELETE', url_pattern: '/api/v2/orders/:id', source: 'bundle_analysis' }
        ]
      }
    ],

    // Wave 3 — auth profile
    authProfile: {
      auth_scheme: 'jwt-bearer',
      auth_value_source: 'header:Authorization',
      expires_at: 1735689600,
      jwt_decoded: { header: { alg: 'HS256' }, payload: { sub: 'u1', exp: 1735689600 } },
      refresh_endpoint_hint: '/auth/refresh',
      classified_headers: [
        { name: 'Authorization', kind: 'bearer-jwt', metadata: { scheme: 'Bearer' } },
        { name: 'X-CSRF-Token', kind: 'csrf', metadata: {} }
      ]
    },

    // Wave 2 — WebSocket capture
    wsConnections: [
      { connection_id: 'ws-1', url: 'wss://app.example.com/realtime' }
    ],
    wsFrames: [
      { connection_id: 'ws-1', direction: 'outbound', timestamp: 1700000010000, payload: 'ping' },
      { connection_id: 'ws-1', direction: 'inbound', timestamp: 1700000010100, payload: 'pong' }
    ]
  };
}

// ---------------------------------------------------------------------------
// 1. Empty-session export
// ---------------------------------------------------------------------------

{
  const result = exportMCP(emptySession());
  assert(typeof result === 'object', 'empty: returns object');
  assert(typeof result.content === 'string', 'empty: content is string');
  assert(result.mimeType === 'application/json', 'empty: mime type set');

  const out = parse(result);

  // v1.0.12 fields present
  assert(out.type === 'workflow_recording', 'empty: type field preserved');
  assert(out.schema_version === '1.0', 'empty: schema_version preserved');
  assert(out.session_id === 'sess-empty', 'empty: session_id preserved');
  assert(Array.isArray(out.steps), 'empty: steps array');
  assert(Array.isArray(out.api_map), 'empty: api_map array');
  assert(Array.isArray(out.injectable_fields), 'empty: injectable_fields array');

  // v1.0.13 fields present with defaults
  assert(out.auth_state !== undefined, 'empty: auth_state block exists');
  assert(out.auth_state.auth_scheme === 'none', 'empty: auth_scheme defaults to "none"');
  assert(Array.isArray(out.auth_state.cookies), 'empty: cookies array');
  assert(out.auth_state.cookies.length === 0, 'empty: cookies empty');
  assert(typeof out.auth_state.localStorage === 'object', 'empty: localStorage object');
  assert(Array.isArray(out.auth_state.indexedDB), 'empty: indexedDB array');
  assert(out.auth_state.refresh_policy === null, 'empty: refresh_policy null');

  assert(Array.isArray(out.discovered_endpoints), 'empty: discovered_endpoints array');
  assert(out.discovered_endpoints.length === 0, 'empty: discovered_endpoints empty');

  assert(typeof out.pagination_strategies === 'object', 'empty: pagination_strategies object');
  assert(Object.keys(out.pagination_strategies).length === 0, 'empty: pagination_strategies empty');

  assert(typeof out.semantic_endpoints === 'object', 'empty: semantic_endpoints object');
  assert(out.challenge_layer === null, 'empty: challenge_layer null');
  assert(Array.isArray(out.ws_exchanges), 'empty: ws_exchanges array');
}

// ---------------------------------------------------------------------------
// 2. Full-session export
// ---------------------------------------------------------------------------

{
  const result = exportMCP(fullSession());
  const out = parse(result);

  // v1.0.12 fields still populated
  assert(out.steps.length === 2, 'full: 2 steps (nav + click)');
  assert(out.api_map.length === 2, 'full: 2 api_map entries');
  assert(out.injectable_fields.length === 1, 'full: 1 injectable field');

  // auth_state
  const auth = out.auth_state;
  assert(auth.auth_scheme === 'jwt-bearer', 'full: auth_scheme jwt-bearer');
  assert(auth.auth_value_source === 'header:Authorization', 'full: auth_value_source');
  assert(auth.cookies.length === 1, 'full: last cookieSnapshot wins');
  assert(auth.cookies[0].value === 'abc-NEW', 'full: cookie value is from last snapshot');
  assert(auth.localStorage.authToken === 'tok-1', 'full: localStorage propagated');
  assert(auth.sessionStorage.tabId === 'tab-7', 'full: sessionStorage propagated');
  assert(auth.indexedDB.length === 1, 'full: indexedDB present');
  assert(auth.indexedDB[0].key_count === 3, 'full: indexedDB key_count derived');
  assert(auth.indexedDB[0].sample === undefined, 'full: indexedDB values stripped (metadata only)');
  assert(auth.classified_headers.length === 2, 'full: classified_headers from authProfile');
  assert(auth.expires_at === 1735689600 * 1000, 'full: expires_at converted to ms');
  assert(auth.jwt_decoded && auth.jwt_decoded.payload.sub === 'u1', 'full: jwt_decoded passed through');
  assert(auth.refresh_policy && auth.refresh_policy.refresh_endpoint === '/auth/refresh',
    'full: refresh_endpoint from hint');
  assert(auth.refresh_policy.method === 'POST', 'full: refresh method defaults to POST');
  assert(auth.refresh_policy.trigger === 'expiry-time', 'full: refresh trigger expiry-time when expires_at present');

  // discovered_endpoints — dedupe check
  assert(out.discovered_endpoints.length === 3, 'full: 3 deduped discovered_endpoints');
  const methods = out.discovered_endpoints.map(e => e.method).sort();
  assert(methods.join(',') === 'DELETE,GET,POST', 'full: all three methods present');

  // pagination_strategies
  const pagKey = '/api/v2/orders';
  assert(out.pagination_strategies[pagKey] !== undefined, 'full: pagination keyed by pathname');
  assert(out.pagination_strategies[pagKey].scheme === 'cursor', 'full: pagination scheme cursor');
  assert(out.pagination_strategies[pagKey].cursor_field === 'nextPageToken', 'full: cursor_field set');

  // semantic_endpoints
  const semKey = 'POST /api/v2/orders/create';
  assert(out.semantic_endpoints[semKey] !== undefined, 'full: semantic_endpoint keyed by METHOD URL');
  assert(out.semantic_endpoints[semKey].label === 'Submit order', 'full: semantic label from button text');
  assert(typeof out.semantic_endpoints[semKey].triggered_by === 'string', 'full: triggered_by string');

  // challenge_layer
  assert(out.challenge_layer === 'cloudflare', 'full: challenge_layer propagated');

  // ws_exchanges
  assert(out.ws_exchanges.length === 1, 'full: 1 ws connection');
  assert(out.ws_exchanges[0].connection_id === 'ws-1', 'full: ws connection_id matches');
  assert(out.ws_exchanges[0].url === 'wss://app.example.com/realtime', 'full: ws url passed through');
  assert(Array.isArray(out.ws_exchanges[0].exchanges), 'full: ws exchanges array');
  assert(out.ws_exchanges[0].exchanges.length === 1, 'full: 1 ws exchange (req+reply)');
}

// ---------------------------------------------------------------------------
// 3. Missing-authProfile defensive case
// ---------------------------------------------------------------------------

{
  const session = fullSession();
  delete session.authProfile;
  // Also nuke per-event classifications to force defensive baseline
  session.networkEvents.forEach(n => { delete n.auth_classification; });

  const out = parse(exportMCP(session));
  assert(out.auth_state.auth_scheme === 'none', 'no-authProfile: scheme falls back to "none"');
  assert(out.auth_state.auth_value_source === null, 'no-authProfile: value_source null');
  assert(out.auth_state.expires_at === null, 'no-authProfile: expires_at null');
  assert(out.auth_state.jwt_decoded === null, 'no-authProfile: jwt_decoded null');
  assert(out.auth_state.refresh_policy === null, 'no-authProfile: refresh_policy null');
  // But cookies/storage/etc still come through (they're independent sources)
  assert(out.auth_state.cookies.length === 1, 'no-authProfile: cookies still captured');
  assert(out.auth_state.localStorage.authToken === 'tok-1', 'no-authProfile: storage still captured');
  // Other blocks still populated
  assert(out.discovered_endpoints.length === 3, 'no-authProfile: discovered_endpoints unaffected');
  assert(out.challenge_layer === 'cloudflare', 'no-authProfile: challenge_layer unaffected');
}

// ---------------------------------------------------------------------------
// 4. Missing optional fields — defensive
// ---------------------------------------------------------------------------

{
  // Session with NONE of the Wave 1/2/3 fields — exporter must not throw
  const skeletal = {
    id: 'sess-skel',
    startTime: 0,
    startUrl: 'https://x',
    events: [],
    networkEvents: []
  };
  let threw = false;
  let out;
  try {
    out = parse(exportMCP(skeletal));
  } catch (e) {
    threw = true;
  }
  assert(!threw, 'skeletal: exporter does not throw');
  assert(out.auth_state !== undefined, 'skeletal: auth_state still present');
  assert(out.discovered_endpoints.length === 0, 'skeletal: discovered_endpoints []');
  assert(out.ws_exchanges.length === 0, 'skeletal: ws_exchanges []');
  assert(out.challenge_layer === null, 'skeletal: challenge_layer null');
}

// ---------------------------------------------------------------------------
// 5. Section isolation — one section's bad data must not break siblings
// ---------------------------------------------------------------------------

{
  const session = fullSession();
  // Poison ws data with non-iterable garbage
  session.wsFrames = 'not-an-array';
  session.wsConnections = 'not-an-array';

  const out = parse(exportMCP(session));
  // The auth_state etc must still be populated
  assert(out.auth_state.auth_scheme === 'jwt-bearer', 'isolation: auth_state survives ws poisoning');
  assert(out.discovered_endpoints.length === 3, 'isolation: discovered_endpoints survive');
  assert(Array.isArray(out.ws_exchanges), 'isolation: ws_exchanges still array');
  assert(out.ws_exchanges.length === 0, 'isolation: ws_exchanges empty after poisoning');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nmcp-exporter.test.js: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('FAILED:', fails);
  process.exit(1);
}
process.exit(0);
