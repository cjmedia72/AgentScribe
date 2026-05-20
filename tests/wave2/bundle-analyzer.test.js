// tests/wave2/bundle-analyzer.test.js
// Node-runnable, zero deps. ES module.
//
//   node tests/wave2/bundle-analyzer.test.js
//
// Exit code 0 = pass, 1 = fail.

import { analyzeBundle } from '../../bundle-analyzer.js';

let passed = 0;
let failed = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL ${name}\n       ${err && err.message ? err.message : err}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---------------------------------------------------------------------------
// 1. API base URL extraction from minified-style JS
// ---------------------------------------------------------------------------
t('extracts api base URLs from minified bundle', () => {
  const src = `var a="https://api.example.com/v2";var b="https://example.com/graphql";fetch("https://api.example.com/v2/users")`;
  const r = analyzeBundle({ scriptUrls: ['app.min.js'], scriptSources: [src] });
  assert(r.api_base_urls.includes('https://api.example.com/v2'), 'missing v2 base');
});

// ---------------------------------------------------------------------------
// 2. Endpoint discovery + method inference
// ---------------------------------------------------------------------------
t('discovers endpoint literals and infers method from axios.post', () => {
  const src = `axios.post('/api/v2/orders', payload); fetch('/api/v2/orders/123');`;
  const r = analyzeBundle({ scriptUrls: ['x.js'], scriptSources: [src] });
  const hit = r.discovered_endpoints.find((e) => e.url_pattern === '/api/v2/orders');
  assert(hit, 'orders endpoint not discovered');
  assert(hit.method === 'POST' || hit.method === 'inferred', `expected POST got ${hit.method}`);
});

t('discovers endpoint with fetch + method option', () => {
  const src = `fetch('/api/v1/login', { method: 'POST', body: x });`;
  const r = analyzeBundle({ scriptUrls: ['x.js'], scriptSources: [src] });
  const hit = r.discovered_endpoints.find((e) => e.url_pattern === '/api/v1/login');
  assert(hit && hit.method === 'POST', `expected POST got ${hit && hit.method}`);
});

// ---------------------------------------------------------------------------
// 3. Signing function detection — CryptoJS + crypto.subtle
// ---------------------------------------------------------------------------
t('detects CryptoJS.HmacSHA256 signer', () => {
  const src = `var sig = CryptoJS.HmacSHA256(payload, secret);`;
  const r = analyzeBundle({ scriptUrls: ['signer.js'], scriptSources: [src] });
  const hit = r.signing_functions.find((s) => s.algorithm === 'HMAC-SHA256');
  assert(hit, 'HMAC-SHA256 not detected');
  assert(hit.location.startsWith('signer.js#L'), `bad location: ${hit.location}`);
});

t('detects crypto.subtle.sign signer', () => {
  const src = `\n\nawait crypto.subtle.sign({name:'HMAC'}, key, data);`;
  const r = analyzeBundle({ scriptUrls: ['sub.js'], scriptSources: [src] });
  const hit = r.signing_functions.find((s) => s.algorithm === 'custom');
  assert(hit, 'crypto.subtle.sign not detected');
  assert(hit.location.includes('#L'), 'location must have line');
});

// ---------------------------------------------------------------------------
// 4. Refresh endpoint scoring
// ---------------------------------------------------------------------------
t('scores refresh endpoint higher when adjacent to fetch + grant_type', () => {
  const adjacent = `fetch('/auth/refresh', { method:'POST', body:'grant_type=refresh_token' });`;
  const lonely = `var u = '/api/auth/renew';`;
  const r1 = analyzeBundle({ scriptUrls: ['a.js'], scriptSources: [adjacent] });
  const r2 = analyzeBundle({ scriptUrls: ['b.js'], scriptSources: [lonely] });
  const h1 = r1.refresh_endpoint_candidates.find((c) => c.url === '/auth/refresh');
  const h2 = r2.refresh_endpoint_candidates.find((c) => c.url === '/api/auth/renew');
  assert(h1 && h2, 'both refresh candidates should be detected');
  assert(h1.confidence > h2.confidence, `expected adjacent (${h1.confidence}) > lonely (${h2.confidence})`);
  assert(h1.confidence > 0.6, `adjacent confidence too low: ${h1.confidence}`);
});

// ---------------------------------------------------------------------------
// 5. GraphQL detection
// ---------------------------------------------------------------------------
t('detects /graphql endpoint literal', () => {
  const src = `var u = '/api/graphql'; var v='/graphql';`;
  const r = analyzeBundle({ scriptUrls: ['g.js'], scriptSources: [src] });
  assert(r.graphql_endpoints.includes('/api/graphql'), 'missing /api/graphql');
  assert(r.graphql_endpoints.includes('/graphql'), 'missing /graphql');
});

t('detects graphql from fetch body with query key', () => {
  const src = `fetch('/svc', { body: JSON.stringify({ "query": "query Foo { bar }" }) });`;
  const r = analyzeBundle({ scriptUrls: ['gb.js'], scriptSources: [src] });
  assert(r.graphql_endpoints.some((g) => g.includes('inferred')), 'inferred graphql missing');
});

// ---------------------------------------------------------------------------
// 6. CSRF endpoint detection
// ---------------------------------------------------------------------------
t('detects /csrf-token endpoint', () => {
  const src = `fetch('/api/csrf-token').then(r=>r.json());`;
  const r = analyzeBundle({ scriptUrls: ['c.js'], scriptSources: [src] });
  assert(r.csrf_token_endpoints.some((e) => e.url === '/api/csrf-token'), 'csrf endpoint missing');
});

// ---------------------------------------------------------------------------
// 7. Defensive: empty / null / non-string input
// ---------------------------------------------------------------------------
t('handles empty input gracefully', () => {
  const r = analyzeBundle({ scriptUrls: [], scriptSources: [] });
  assert(Array.isArray(r.api_base_urls), 'must return arrays even on empty input');
  assert(r.warnings.length > 0, 'should warn on empty');
});

t('handles undefined args', () => {
  const r = analyzeBundle();
  assert(r && Array.isArray(r.api_base_urls), 'must not throw on undefined args');
});

t('skips non-string sources with warning', () => {
  const r = analyzeBundle({
    scriptUrls: ['a.js', 'b.js', 'c.js'],
    scriptSources: [null, 12345, 'var x = "/api/v1/ping";'],
  });
  assert(r.warnings.length >= 2, `expected >=2 warnings, got ${r.warnings.length}`);
  assert(
    r.discovered_endpoints.some((e) => e.url_pattern === '/api/v1/ping'),
    'valid third source should still be scanned'
  );
});

t('handles weird unicode / surrogate pairs without crashing', () => {
  const src = `var x = "𝕳𝖊𝖑𝖑𝖔"; fetch('/api/v1/emoji-🚀-path');`;
  const r = analyzeBundle({ scriptUrls: ['u.js'], scriptSources: [src] });
  assert(Array.isArray(r.discovered_endpoints), 'should return result without throwing');
});

// ---------------------------------------------------------------------------
// 8. Deduplication
// ---------------------------------------------------------------------------
t('deduplicates repeated api base URLs and endpoints', () => {
  const src = `
    var a = "https://api.example.com/v2";
    var b = "https://api.example.com/v2";
    fetch('/api/v2/x'); fetch('/api/v2/x');
  `;
  const r = analyzeBundle({ scriptUrls: ['d.js'], scriptSources: [src] });
  const baseCount = r.api_base_urls.filter((u) => u === 'https://api.example.com/v2').length;
  const epCount = r.discovered_endpoints.filter((e) => e.url_pattern === '/api/v2/x').length;
  assert(baseCount === 1, `expected 1 base, got ${baseCount}`);
  assert(epCount === 1, `expected 1 endpoint, got ${epCount}`);
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nbundle-analyzer.test.js — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
