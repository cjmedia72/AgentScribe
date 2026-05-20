/*
 * AgentScribe ws-capture.js test
 *
 * Runs via `node --test tests/wave2/ws-capture.test.js`.
 *
 * Strategy:
 *   - Build a minimal browser-like sandbox (window, WebSocket, EventSource,
 *     postMessage, btoa, FileReader stub).
 *   - vm.runInContext() the ws-capture.js source against the sandbox.
 *   - Drive mock WebSocket / EventSource instances and assert that the
 *     expected `agentscribe-ws` envelopes were posted.
 *
 * No external dependencies. Pure Node stdlib.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT_PATH = path.resolve(__dirname, '..', '..', 'ws-capture.js');
const SCRIPT_SRC = fs.readFileSync(SCRIPT_PATH, 'utf8');

// ---------------------------------------------------------------------------
// Mock WebSocket / EventSource implementations
// ---------------------------------------------------------------------------

function makeMockWebSocketCtor() {
  class MockWS {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = 0;
      this._listeners = { message: [], close: [], error: [], open: [] };
      this.onmessage = null;
    }
    addEventListener(type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    send(_data) {
      // Original send: store last payload for inspection.
      this._lastSent = _data;
    }
    close(code, reason) {
      this.readyState = 3;
      this._fire('close', { code: code || 1000, reason: reason || '' });
    }
    _fire(type, ev) {
      ev = ev || {};
      const fns = this._listeners[type] || [];
      for (const fn of fns) {
        try { fn(ev); } catch (_) { /* swallow */ }
      }
      if (type === 'message' && typeof this.onmessage === 'function') {
        try { this.onmessage(ev); } catch (_) { /* swallow */ }
      }
    }
  }
  MockWS.OPEN = 1;
  MockWS.CLOSED = 3;
  MockWS.CONNECTING = 0;
  MockWS.CLOSING = 2;
  return MockWS;
}

function makeMockEventSourceCtor() {
  class MockES {
    constructor(url, init) {
      this.url = url;
      this.init = init;
      this.readyState = 0;
      this._listeners = { message: [], error: [], open: [] };
    }
    addEventListener(type, fn) {
      if (!this._listeners[type]) this._listeners[type] = [];
      this._listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      const arr = this._listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    }
    close() { this.readyState = 2; }
    _fire(type, ev) {
      const fns = this._listeners[type] || [];
      for (const fn of fns) {
        try { fn(ev); } catch (_) { /* swallow */ }
      }
    }
  }
  MockES.CONNECTING = 0;
  MockES.OPEN = 1;
  MockES.CLOSED = 2;
  return MockES;
}

// ---------------------------------------------------------------------------
// Sandbox factory
// ---------------------------------------------------------------------------

function buildSandbox() {
  const posted = [];
  const sandbox = {
    posted,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Date,
    Object,
    String,
    Number,
    Boolean,
    Array,
    Error,
    TypeError,
    ArrayBuffer,
    Uint8Array,
    DataView,
    setTimeout,
    clearTimeout,
    FileReader: function FileReader() {
      this.onload = null;
      this.onerror = null;
      this.result = null;
      this.readAsArrayBuffer = (blob) => {
        // Our mock Blob carries an ArrayBuffer in ._buf.
        this.result = blob && blob._buf ? blob._buf : new ArrayBuffer(0);
        if (typeof this.onload === 'function') this.onload();
      };
    },
    Blob: function Blob(parts) {
      // Minimal Blob mock — concatenate part bytes into an ArrayBuffer.
      const chunks = [];
      for (const p of parts || []) {
        if (typeof p === 'string') chunks.push(Buffer.from(p, 'utf8'));
        else if (p instanceof ArrayBuffer) chunks.push(Buffer.from(p));
        else if (ArrayBuffer.isView(p)) chunks.push(Buffer.from(p.buffer, p.byteOffset, p.byteLength));
      }
      const buf = Buffer.concat(chunks);
      this._buf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
  };

  // Window shim
  sandbox.window = sandbox;
  sandbox.postMessage = (msg, _target) => { posted.push(msg); };

  return sandbox;
}

function runWsCaptureIn(sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT_SRC, sandbox, { filename: 'ws-capture.js' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('ws-capture: loads once and signals ready', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);

  assert.strictEqual(sandbox.__agentscribe_ws_capture_loaded, true);
  const readyMsgs = sandbox.posted.filter(m => m && m.type === 'ready');
  assert.strictEqual(readyMsgs.length, 1, 'expected exactly one ready envelope');
  assert.strictEqual(readyMsgs[0].source, 'agentscribe-ws');
});

test('ws-capture: idempotent — second load is a no-op', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);
  const firstPostCount = sandbox.posted.length;
  // Run again in the same context.
  vm.runInContext(SCRIPT_SRC, sandbox, { filename: 'ws-capture.js' });
  assert.strictEqual(sandbox.posted.length, firstPostCount, 'second run should not post');
});

test('ws-capture: WebSocket connect emits connect envelope', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);

  // Create a WS via the WRAPPED constructor in the sandbox.
  vm.runInContext("globalThis.__ws1 = new WebSocket('wss://example.test/socket', ['proto-a']);", sandbox);

  const connects = sandbox.posted.filter(m => m && m.type === 'connect');
  assert.strictEqual(connects.length, 1);
  assert.strictEqual(connects[0].connection.kind, 'websocket');
  assert.strictEqual(connects[0].connection.url, 'wss://example.test/socket');
  // Cross-realm array — compare by content, not prototype identity.
  const protos = Array.from(connects[0].connection.protocols || []);
  assert.deepStrictEqual(protos, ['proto-a']);
  assert.ok(typeof connects[0].connection.id === 'string' && connects[0].connection.id.length > 0);
});

test('ws-capture: outbound text frame captured via .send()', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);

  vm.runInContext(`
    const ws = new WebSocket('wss://example.test/x');
    ws.send('hello-world');
    globalThis.__ws_for_send = ws;
  `, sandbox);

  const frames = sandbox.posted.filter(m => m && m.type === 'frame');
  const outbound = frames.filter(f => f.frame.direction === 'outbound');
  assert.strictEqual(outbound.length, 1);
  assert.strictEqual(outbound[0].frame.payload_kind, 'text');
  assert.strictEqual(outbound[0].frame.payload, 'hello-world');
  // Original send still called — our mock stores _lastSent.
  assert.strictEqual(sandbox.__ws_for_send._lastSent, 'hello-world');
});

test('ws-capture: outbound binary frame captured + base64-encoded', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);

  vm.runInContext(`
    const ws = new WebSocket('wss://example.test/b');
    const buf = new Uint8Array([72, 105, 33]); // "Hi!"
    ws.send(buf);
  `, sandbox);

  const frames = sandbox.posted.filter(m => m && m.type === 'frame' && m.frame.direction === 'outbound');
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].frame.payload_kind, 'binary');
  // Base64 of "Hi!" is "SGkh"
  assert.strictEqual(frames[0].frame.payload, 'SGkh');
});

test('ws-capture: inbound message via addEventListener AND .onmessage both still fire on page side', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);

  vm.runInContext(`
    globalThis.__al_fired = 0;
    globalThis.__om_fired = 0;
    const ws = new WebSocket('wss://example.test/m');
    ws.addEventListener('message', (ev) => { globalThis.__al_fired += 1; globalThis.__al_data = ev.data; });
    ws.onmessage = (ev) => { globalThis.__om_fired += 1; globalThis.__om_data = ev.data; };
    globalThis.__ws_m = ws;
  `, sandbox);

  // Drive an inbound frame via the mock's internal _fire.
  sandbox.__ws_m._fire('message', { data: 'pong' });

  // Page-side handlers must both have fired.
  assert.strictEqual(sandbox.__al_fired, 1, 'addEventListener handler must fire');
  assert.strictEqual(sandbox.__om_fired, 1, '.onmessage handler must fire');
  assert.strictEqual(sandbox.__al_data, 'pong');
  assert.strictEqual(sandbox.__om_data, 'pong');

  // We must have captured the inbound frame exactly once.
  const inbound = sandbox.posted.filter(m => m && m.type === 'frame' && m.frame.direction === 'inbound');
  assert.strictEqual(inbound.length, 1);
  assert.strictEqual(inbound[0].frame.payload_kind, 'text');
  assert.strictEqual(inbound[0].frame.payload, 'pong');
});

test('ws-capture: close emits close envelope with code+reason', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);

  vm.runInContext(`
    globalThis.__ws_c = new WebSocket('wss://example.test/c');
  `, sandbox);

  sandbox.__ws_c.close(1001, 'going-away');

  const closes = sandbox.posted.filter(m => m && m.type === 'close');
  assert.strictEqual(closes.length, 1);
  assert.strictEqual(closes[0].code, 1001);
  assert.strictEqual(closes[0].reason, 'going-away');
});

test('ws-capture: EventSource connect + inbound frame', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);

  vm.runInContext(`
    globalThis.__es1 = new EventSource('https://example.test/stream');
  `, sandbox);

  const connects = sandbox.posted.filter(m => m && m.type === 'connect' && m.connection.kind === 'eventsource');
  assert.strictEqual(connects.length, 1);
  assert.strictEqual(connects[0].connection.url, 'https://example.test/stream');

  // Drive an inbound SSE message.
  sandbox.__es1._fire('message', { data: 'event-payload' });

  const frames = sandbox.posted.filter(m => m && m.type === 'frame' && m.frame.direction === 'inbound');
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].frame.payload, 'event-payload');
  assert.strictEqual(frames[0].frame.payload_kind, 'text');
});

test('ws-capture: EventSource.close() emits close envelope', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);

  vm.runInContext(`
    globalThis.__es_c = new EventSource('https://example.test/s');
    __es_c.close();
  `, sandbox);

  const closes = sandbox.posted.filter(m => m && m.type === 'close');
  assert.strictEqual(closes.length, 1);
  assert.strictEqual(closes[0].reason, 'eventsource-close');
});

test('ws-capture: missing WebSocket constructor does not throw', () => {
  const sandbox = buildSandbox();
  // Intentionally no WebSocket / EventSource on sandbox.
  // Script must run cleanly.
  assert.doesNotThrow(() => runWsCaptureIn(sandbox));
  assert.strictEqual(sandbox.__agentscribe_ws_capture_loaded, true);
});

test('ws-capture: monotonic connection IDs', () => {
  const sandbox = buildSandbox();
  sandbox.WebSocket = makeMockWebSocketCtor();
  sandbox.EventSource = makeMockEventSourceCtor();
  runWsCaptureIn(sandbox);

  vm.runInContext(`
    globalThis.__a = new WebSocket('wss://a');
    globalThis.__b = new WebSocket('wss://b');
    globalThis.__c = new EventSource('https://c');
  `, sandbox);

  const ids = sandbox.posted
    .filter(m => m && m.type === 'connect')
    .map(m => m.connection.id);
  assert.strictEqual(ids.length, 3);
  // All distinct.
  assert.strictEqual(new Set(ids).size, 3);
});
