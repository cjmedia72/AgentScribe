// tests/wave2/storage-snapshot.test.js
// Node-runnable smoke test for storage-snapshot.js.
// Mocks localStorage / sessionStorage and skips IDB (no jsdom in CI).
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

function makeStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    get length() { return m.size; },
    key(i) { return Array.from(m.keys())[i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { m.set(k, String(v)); },
    removeItem(k) { m.delete(k); },
    clear() { m.clear(); },
  };
}

const modUrl = pathToFileURL(
  path.resolve(process.cwd(), 'storage-snapshot.js')
).href;

async function happyPath() {
  globalThis.localStorage = makeStorage({ token: 'abc', userId: '42' });
  globalThis.sessionStorage = makeStorage({ csrf: 'xyz' });
  delete globalThis.indexedDB;
  const { snapshotStorage } = await import(modUrl);
  const snap = await snapshotStorage({ budgetMs: 500 });
  assert.equal(snap.localStorage.token, 'abc');
  assert.equal(snap.localStorage.userId, '42');
  assert.equal(snap.sessionStorage.csrf, 'xyz');
  assert.ok(Array.isArray(snap.indexedDB));
  assert.equal(snap.indexedDB.length, 0);
  console.log('ok happy-path');
}

async function securityErrorPath() {
  const throwing = new Proxy({}, {
    get() { const e = new Error('SecurityError'); e.name = 'SecurityError'; throw e; },
  });
  globalThis.localStorage = throwing;
  globalThis.sessionStorage = makeStorage({ k: 'v' });
  delete globalThis.indexedDB;
  const { snapshotStorage } = await import(modUrl);
  const snap = await snapshotStorage({ budgetMs: 500 });
  assert.deepEqual(snap.localStorage, {});
  assert.equal(snap.localStorageError, 'SecurityError');
  assert.equal(snap.sessionStorage.k, 'v');
  console.log('ok security-error');
}

await happyPath();
await securityErrorPath();
console.log('all tests passed');
