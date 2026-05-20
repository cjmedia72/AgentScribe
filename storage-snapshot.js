// storage-snapshot.js
// AgentScribe — page-context storage snapshot module.
// Dumps localStorage + sessionStorage + IndexedDB metadata defensively.
// Pure page-context — no chrome.* APIs. Importable as ES module in browser
// or via Node for testing.

const DEFAULT_BUDGET_MS = 2000;
const SAMPLE_KEY_LIMIT = 10;

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function dumpWebStorage(storage) {
  // Returns { ok: true, data } or { ok: false, error: string }.
  try {
    if (!storage) return { ok: false, error: 'unavailable' };
    const out = {};
    const len = storage.length;
    for (let i = 0; i < len; i++) {
      const key = storage.key(i);
      if (key == null) continue;
      try {
        out[key] = storage.getItem(key);
      } catch (innerErr) {
        out[key] = null;
      }
    }
    return { ok: true, data: out };
  } catch (err) {
    return { ok: false, error: (err && err.name) || 'error' };
  }
}

function promiseTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      (_err) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(fallback);
      }
    );
  });
}

function openDbReadOnly(idb, name, version) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = version != null ? idb.open(name, version) : idb.open(name);
    } catch (err) {
      reject(err);
      return;
    }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('open-failed'));
    req.onblocked = () => reject(new Error('blocked'));
    // Don't upgrade — bail if the browser thinks we'd be upgrading.
    req.onupgradeneeded = () => {
      try { req.transaction && req.transaction.abort(); } catch (_) {}
      reject(new Error('would-upgrade'));
    };
  });
}

function countStore(store) {
  return new Promise((resolve) => {
    try {
      const r = store.count();
      r.onsuccess = () => resolve(typeof r.result === 'number' ? r.result : 0);
      r.onerror = () => resolve(0);
    } catch (_) {
      resolve(0);
    }
  });
}

function sampleStoreKeys(store, limit) {
  return new Promise((resolve) => {
    const keys = [];
    let req;
    try {
      req = store.openKeyCursor ? store.openKeyCursor() : store.openCursor();
    } catch (_) {
      resolve(keys);
      return;
    }
    req.onsuccess = (ev) => {
      const cursor = ev.target.result;
      if (!cursor || keys.length >= limit) {
        resolve(keys);
        return;
      }
      try {
        const k = cursor.key;
        keys.push(typeof k === 'string' ? k : String(k));
      } catch (_) {
        // ignore individual key errors
      }
      try { cursor.continue(); } catch (_) { resolve(keys); }
    };
    req.onerror = () => resolve(keys);
  });
}

async function snapshotOneStore(db, storeName) {
  const result = {
    db: db.name,
    version: db.version,
    store: storeName,
    keys: 0,
    sampleKeys: [],
    sampleSize: 0,
    schema: null,
  };
  let tx;
  try {
    tx = db.transaction(storeName, 'readonly');
  } catch (err) {
    result.error = (err && err.name) || 'tx-failed';
    return result;
  }
  let store;
  try {
    store = tx.objectStore(storeName);
    result.schema = {
      keyPath: store.keyPath == null ? null : store.keyPath,
      autoIncrement: !!store.autoIncrement,
      indexes: Array.from(store.indexNames || []),
    };
  } catch (err) {
    result.error = (err && err.name) || 'store-failed';
    return result;
  }
  const [count, sample] = await Promise.all([
    countStore(store),
    sampleStoreKeys(store, SAMPLE_KEY_LIMIT),
  ]);
  result.keys = count;
  result.sampleKeys = sample;
  result.sampleSize = sample.length;
  return result;
}

async function snapshotIndexedDb(idb, budgetMs) {
  const out = [];
  if (!idb || typeof idb.databases !== 'function') {
    // Firefox / older browsers don't expose databases() — return empty.
    return out;
  }
  let dbs;
  try {
    dbs = await promiseTimeout(idb.databases(), budgetMs, null);
  } catch (_) {
    return out;
  }
  if (!Array.isArray(dbs)) return out;
  const deadline = nowMs() + budgetMs;
  for (const meta of dbs) {
    if (nowMs() >= deadline) break;
    if (!meta || !meta.name) continue;
    let db;
    try {
      db = await openDbReadOnly(idb, meta.name, meta.version);
    } catch (err) {
      out.push({
        db: meta.name,
        version: meta.version || null,
        store: null,
        keys: 0,
        sampleKeys: [],
        sampleSize: 0,
        error: (err && err.name) || (err && err.message) || 'open-failed',
      });
      continue;
    }
    const storeNames = Array.from(db.objectStoreNames || []);
    for (const storeName of storeNames) {
      if (nowMs() >= deadline) break;
      try {
        const snap = await snapshotOneStore(db, storeName);
        out.push(snap);
      } catch (err) {
        out.push({
          db: db.name,
          version: db.version,
          store: storeName,
          keys: 0,
          sampleKeys: [],
          sampleSize: 0,
          error: (err && err.name) || 'snapshot-failed',
        });
      }
    }
    try { db.close(); } catch (_) {}
  }
  return out;
}

export async function snapshotStorage(options = {}) {
  const budgetMs = typeof options.budgetMs === 'number' && options.budgetMs > 0
    ? options.budgetMs
    : DEFAULT_BUDGET_MS;
  const start = nowMs();

  const scope = (typeof globalThis !== 'undefined' && globalThis) || {};
  const ls = scope.localStorage;
  const ss = scope.sessionStorage;
  const idb = scope.indexedDB;

  const result = {
    localStorage: {},
    sessionStorage: {},
    indexedDB: [],
    truncated: false,
  };

  const lsDump = dumpWebStorage(ls);
  if (lsDump.ok) {
    result.localStorage = lsDump.data;
  } else {
    result.localStorageError = lsDump.error;
  }

  const ssDump = dumpWebStorage(ss);
  if (ssDump.ok) {
    result.sessionStorage = ssDump.data;
  } else {
    result.sessionStorageError = ssDump.error;
  }

  const remaining = budgetMs - (nowMs() - start);
  if (remaining <= 50) {
    result.truncated = true;
    return result;
  }

  try {
    const idbResult = await promiseTimeout(
      snapshotIndexedDb(idb, remaining),
      remaining,
      null
    );
    if (idbResult == null) {
      result.truncated = true;
    } else {
      result.indexedDB = idbResult;
    }
  } catch (_) {
    result.truncated = true;
  }

  if (nowMs() - start >= budgetMs) {
    result.truncated = true;
  }

  return result;
}

export default { snapshotStorage };
