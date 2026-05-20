// auth-detector.test.mjs
// Node-runnable tests for auth-detector.
// Run: node tests/wave2/auth-detector.test.mjs

import {
  classifyRequest,
  decodeJWT,
  findRefreshEndpoint,
  classifyHeader,
} from '../../auth-detector.js';

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

// Helper: build a valid JWT (HS256-ish, no signature verification needed for decode)
function makeJWT(payload = {}, header = { alg: 'HS256', typ: 'JWT' }) {
  const b64 = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64(header)}.${b64(payload)}.sigplaceholder`;
}

// 1. decodeJWT — valid
{
  const token = makeJWT({ sub: 'u1', exp: 1700000000, iss: 'acme', aud: 'api' });
  const j = decodeJWT(token);
  assert(j !== null, 'decodeJWT: valid token returns object');
  assert(j && j.exp === 1700000000, 'decodeJWT: extracts exp');
  assert(j && j.iss === 'acme', 'decodeJWT: extracts iss');
  assert(j && j.aud === 'api', 'decodeJWT: extracts aud');
  assert(j && j.header.alg === 'HS256', 'decodeJWT: parses header');
}

// 2. decodeJWT — malformed
{
  assert(decodeJWT(null) === null, 'decodeJWT: null returns null');
  assert(decodeJWT('') === null, 'decodeJWT: empty returns null');
  assert(decodeJWT('not.a.jwt') === null, 'decodeJWT: garbage 3-parts returns null');
  assert(decodeJWT('only.twoparts') === null, 'decodeJWT: 2-part returns null');
  assert(decodeJWT('a.b.c.d') === null, 'decodeJWT: 4-part returns null');
  // Valid base64 but non-JSON middle
  const badMiddle = 'eyJhbGciOiJIUzI1NiJ9.bm90anNvbg.sig';
  assert(decodeJWT(badMiddle) === null, 'decodeJWT: non-JSON payload returns null');
}

// 3. classifyRequest — Bearer JWT
{
  const token = makeJWT({ exp: 1800000000, iss: 'acme' });
  const r = classifyRequest({
    headers: { Authorization: `Bearer ${token}` },
    cookies: [],
    url: 'https://api.example.com/users',
    method: 'GET',
  });
  assert(r.auth_scheme === 'jwt-bearer', 'classify: detects jwt-bearer');
  assert(r.auth_value_source === 'header:Authorization', 'classify: jwt source header');
  assert(r.jwt_decoded !== null, 'classify: jwt_decoded populated');
  assert(r.expires_at === 1800000000 * 1000, 'classify: expires_at in epoch ms');
  assert(r.confidence >= 0.9, 'classify: jwt confidence high');
}

// 4. classifyRequest — opaque OAuth bearer
{
  const r = classifyRequest({
    headers: { Authorization: 'Bearer opaque-token-xyz' },
    cookies: [],
  });
  assert(r.auth_scheme === 'oauth-bearer', 'classify: opaque bearer = oauth-bearer');
  assert(r.jwt_decoded === null, 'classify: opaque has no jwt_decoded');
}

// 5. classifyRequest — session cookie only
{
  const r = classifyRequest({
    headers: {},
    cookies: [
      { name: '_session_id', value: 'abc123' },
      { name: 'tracking', value: 'xyz' },
    ],
  });
  assert(r.auth_scheme === 'session-cookie', 'classify: detects session-cookie');
  assert(r.auth_value_source === 'cookie:_session_id', 'classify: session source cookie');
}

// 6. classifyRequest — CSRF header
{
  const r = classifyRequest({
    headers: { 'X-CSRF-Token': 'csrf-abc' },
    cookies: [],
  });
  assert(r.auth_scheme === 'csrf', 'classify: detects csrf header');
  assert(r.csrf_token_source === 'header:X-CSRF-Token', 'classify: csrf source header');
}

// 7. classifyRequest — API key
{
  const r = classifyRequest({
    headers: { 'X-API-Key': 'sk_live_abc' },
    cookies: [],
  });
  assert(r.auth_scheme === 'api-key', 'classify: detects api-key');
  assert(r.auth_value_source === 'header:X-API-Key', 'classify: api-key source');
}

// 8. classifyRequest — mixed (JWT + session cookie) -> JWT wins
{
  const token = makeJWT({ exp: 1800000000 });
  const r = classifyRequest({
    headers: { Authorization: `Bearer ${token}` },
    cookies: [{ name: '_session_id', value: 'abc' }],
  });
  assert(r.auth_scheme === 'jwt-bearer', 'classify: mixed JWT+session -> JWT wins');
}

// 9. classifyRequest — none
{
  const r = classifyRequest({
    headers: { 'Accept': 'application/json' },
    cookies: [{ name: 'tracking_id', value: 'x' }],
  });
  assert(r.auth_scheme === 'none', 'classify: un-authed request = none');
  assert(r.confidence === 0, 'classify: none has confidence 0');
}

// 10. findRefreshEndpoint
{
  const urls = [
    { url: 'https://api.example.com/auth/refresh', method: 'POST' },
    { url: 'https://api.example.com/users', method: 'GET' },
    { url: 'https://api.example.com/auth/refresh', method: 'GET' }, // wrong method
    { url: 'https://api.example.com/oauth/token', method: 'POST' },
  ];
  const hits = findRefreshEndpoint(urls);
  assert(hits.length === 2, 'findRefreshEndpoint: filters POST + keyword');
  assert(hits[0].url.includes('refresh'), 'findRefreshEndpoint: refresh ranks first');
  assert(hits[0].score > hits[1].score, 'findRefreshEndpoint: scores sorted desc');
}

// 11. classifyHeader
{
  const a = classifyHeader('X-API-Key', 'sk_abc');
  assert(a.kind === 'api-key', 'classifyHeader: X-API-Key');

  const token = makeJWT({ exp: 1800000000 });
  const b = classifyHeader('Authorization', `Bearer ${token}`);
  assert(b.kind === 'bearer-jwt', 'classifyHeader: Bearer JWT');
  assert(b.metadata.exp === 1800000000, 'classifyHeader: bearer exp metadata');

  const c = classifyHeader('X-CSRF-Token', 'abc');
  assert(c.kind === 'csrf', 'classifyHeader: CSRF header');

  const d = classifyHeader('X-Signature', 'sha256=...');
  assert(d.kind === 'hmac-signature', 'classifyHeader: HMAC');

  const e = classifyHeader('User-Agent', 'curl');
  assert(e.kind === 'other', 'classifyHeader: unknown header');
}

// 12. localStorage JWT detection
{
  const token = makeJWT({ exp: 1900000000 });
  const r = classifyRequest({
    headers: {},
    cookies: [],
    storageSnapshot: { localStorage: { authToken: token } },
  });
  assert(r.auth_scheme === 'jwt-bearer', 'classify: localStorage JWT detected');
  assert(r.auth_value_source === 'localStorage:authToken', 'classify: localStorage source');
}

// Summary
console.log(`\nauth-detector tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('Failures:', fails);
  process.exit(1);
}
process.exit(0);
