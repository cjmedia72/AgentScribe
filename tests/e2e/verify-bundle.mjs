#!/usr/bin/env node
// AgentScribe v1.0.13 bundle verifier.
// Usage: node verify-bundle.mjs <path-to-bundle.json>
// Exit 0 = all assertions passed. Exit 1 = at least one assertion failed.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const PASS_PREFIX = `${GREEN}PASS${RESET}`;
const FAIL_PREFIX = `${RED}FAIL${RESET}`;
const WARN_PREFIX = `${YELLOW}WARN${RESET}`;

const results = [];
let failureCount = 0;
let warningCount = 0;

function assert(name, condition, detail = '') {
  if (condition) {
    results.push({ name, pass: true, detail });
    console.log(`${PASS_PREFIX} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
  } else {
    failureCount += 1;
    results.push({ name, pass: false, detail });
    console.log(`${FAIL_PREFIX} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
  }
}

function warn(name, condition, detail = '') {
  if (!condition) {
    warningCount += 1;
    console.log(`${WARN_PREFIX} ${name}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
  }
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function hasKey(obj, key) {
  return isObject(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

// --- argv parsing ---

const argPath = process.argv[2];
if (!argPath) {
  console.error(`${FAIL_PREFIX} usage: node verify-bundle.mjs <path-to-bundle.json>`);
  process.exit(1);
}

const bundlePath = resolve(argPath);
if (!existsSync(bundlePath)) {
  console.error(`${FAIL_PREFIX} bundle not found at: ${bundlePath}`);
  process.exit(1);
}

let bundle;
try {
  const raw = readFileSync(bundlePath, 'utf8');
  bundle = JSON.parse(raw);
} catch (err) {
  console.error(`${FAIL_PREFIX} failed to parse bundle JSON: ${err.message}`);
  process.exit(1);
}

console.log(`${DIM}Verifying bundle:${RESET} ${bundlePath}\n`);

// --- assertions ---

// 1. _meta.schema
assert(
  '_meta exists',
  isObject(bundle._meta),
  '_meta must be an object',
);
assert(
  '_meta.schema === "agentscribe-bundle"',
  bundle?._meta?.schema === 'agentscribe-bundle',
  `got: ${JSON.stringify(bundle?._meta?.schema)}`,
);

// 2. raw_session
const rawSession = bundle.raw_session;
assert(
  'raw_session exists',
  isObject(rawSession),
  'raw_session must be an object',
);

// 3. cookieSnapshots
const cookieSnaps = rawSession?.cookieSnapshots;
assert(
  'raw_session.cookieSnapshots is array',
  Array.isArray(cookieSnaps),
);
assert(
  'raw_session.cookieSnapshots.length >= 1',
  Array.isArray(cookieSnaps) && cookieSnaps.length >= 1,
  `length: ${Array.isArray(cookieSnaps) ? cookieSnaps.length : 'N/A'}`,
);
warn(
  'raw_session.cookieSnapshots.length >= 3 (Walmart-class recording)',
  Array.isArray(cookieSnaps) && cookieSnaps.length >= 3,
  'fewer than 3 snapshots — possible navigation-trigger miss',
);

// 4. storageSnapshots
const storageSnaps = rawSession?.storageSnapshots;
assert(
  'raw_session.storageSnapshots is array',
  Array.isArray(storageSnaps),
);
assert(
  'raw_session.storageSnapshots.length >= 1',
  Array.isArray(storageSnaps) && storageSnaps.length >= 1,
  `length: ${Array.isArray(storageSnaps) ? storageSnaps.length : 'N/A'}`,
);

// Optional: at least one storage snapshot has localStorage entries
const hasLocalStorageContent = Array.isArray(storageSnaps) && storageSnaps.some((s) => {
  const ls = s?.localStorage;
  if (!ls) return false;
  if (Array.isArray(ls)) return ls.length > 0;
  if (isObject(ls)) return Object.keys(ls).length > 0;
  return false;
});
warn(
  'at least one storageSnapshot has localStorage entries',
  hasLocalStorageContent,
  'storage capture may not be wiring through correctly',
);

// 5. auth_profile (key present, value may be null)
assert(
  'auth_profile key present (may be null)',
  hasKey(bundle, 'auth_profile'),
);

// 6. replay_hints with 4 expected keys
const replayHints = bundle.replay_hints;
assert(
  'replay_hints exists',
  isObject(replayHints),
);

const expectedHintKeys = ['requires_csrf_refresh', 'requires_otp', 'challenge_layer', 'replay_strategy'];
for (const key of expectedHintKeys) {
  assert(
    `replay_hints has key: ${key}`,
    hasKey(replayHints, key),
  );
}

// 7. exports — all 5 present
const exports_ = bundle.exports;
assert(
  'exports object exists',
  isObject(exports_),
);
const expectedExports = ['json', 'playwright', 'postman', 'sop', 'mcp'];
for (const fmt of expectedExports) {
  assert(
    `exports.${fmt} present`,
    hasKey(exports_, fmt),
  );
}

// 8. playwright storageState defensive check
if (hasKey(exports_, 'playwright')) {
  const pw = exports_.playwright;
  const storageState = pw?.storageState;
  assert(
    'exports.playwright.storageState is present OR null (key exists)',
    storageState === null || storageState === undefined || isObject(storageState),
    `type: ${storageState === null ? 'null' : typeof storageState}`,
  );
  if (isObject(storageState)) {
    assert(
      'exports.playwright.storageState.cookies is array (when storageState present)',
      Array.isArray(storageState.cookies),
    );
  }
}

// 9. postman environment defensive check
if (hasKey(exports_, 'postman')) {
  const pm = exports_.postman;
  const env = pm?.environment;
  assert(
    'exports.postman.environment is present OR null',
    env === null || env === undefined || isObject(env) || Array.isArray(env),
    `type: ${env === null ? 'null' : Array.isArray(env) ? 'array' : typeof env}`,
  );
}

// 10. JWT — if auth_scheme === 'jwt-bearer', jwt_decoded.exp must exist
const authProfile = bundle.auth_profile;
if (isObject(authProfile) && authProfile.auth_scheme === 'jwt-bearer') {
  assert(
    'auth_profile.jwt_decoded exists when auth_scheme is jwt-bearer',
    isObject(authProfile.jwt_decoded),
  );
  assert(
    'auth_profile.jwt_decoded.exp exists when auth_scheme is jwt-bearer',
    isObject(authProfile.jwt_decoded) && authProfile.jwt_decoded.exp !== undefined && authProfile.jwt_decoded.exp !== null,
    `exp value: ${authProfile?.jwt_decoded?.exp}`,
  );
}

// 11. networkEvents sanity (warn-level — not a hard contract here)
const networkEvents = rawSession?.networkEvents;
warn(
  'raw_session.networkEvents is non-empty array',
  Array.isArray(networkEvents) && networkEvents.length > 0,
  `length: ${Array.isArray(networkEvents) ? networkEvents.length : 'N/A'}`,
);

if (Array.isArray(networkEvents) && networkEvents.length > 0) {
  const hasMutation = networkEvents.some((e) => {
    const m = (e?.method || e?.request?.method || '').toUpperCase();
    return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE';
  });
  warn(
    'at least one networkEvent is a mutating method (POST/PUT/PATCH/DELETE)',
    hasMutation,
    'recording may have only captured GETs',
  );
}

// --- summary ---

console.log('');
console.log(`${DIM}---${RESET}`);
const passCount = results.filter((r) => r.pass).length;
const totalCount = results.length;
console.log(`${DIM}assertions:${RESET} ${passCount}/${totalCount} passed`);
if (warningCount > 0) {
  console.log(`${DIM}warnings:${RESET}   ${warningCount}`);
}
if (failureCount === 0) {
  console.log(`\n${GREEN}OK${RESET} — bundle conforms to v1.0.13 contract`);
  process.exit(0);
} else {
  console.log(`\n${RED}FAILED${RESET} — ${failureCount} assertion(s) failed`);
  process.exit(1);
}
