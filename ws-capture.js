/*
 * AgentScribe ws-capture.js
 *
 * Page-context proxy for WebSocket and EventSource constructors.
 * MUST be injected into the page's MAIN world (not the isolated extension
 * world) so it can intercept the page's own WS/SSE connections.
 *
 * Wave 2 of AgentScribe v1.0.13 wave plan.
 *
 * Reports to the content script via window.postMessage with envelope:
 *   { source: 'agentscribe-ws', type: 'connect'|'frame'|'close', ... }
 *
 * Wave 3 (`content.js`) listens for these and forwards to background.
 */

(() => {
  'use strict';

  if (window.__agentscribe_ws_capture_loaded) return;
  window.__agentscribe_ws_capture_loaded = true;

  // ---------------------------------------------------------------------------
  // Connection ID counter (monotonic, scoped to this injection)
  // ---------------------------------------------------------------------------
  let __connSeq = 0;
  const nextConnectionId = () => {
    __connSeq += 1;
    return 'ws-' + Date.now().toString(36) + '-' + __connSeq;
  };

  // ---------------------------------------------------------------------------
  // Safe postMessage — never let a serialization failure surface to the page
  // ---------------------------------------------------------------------------
  const safePost = (msg) => {
    try {
      window.postMessage(msg, '*');
    } catch (err) {
      try {
        // eslint-disable-next-line no-console
        console.warn('[agentscribe-ws] postMessage failed:', err && err.message);
      } catch (_) { /* swallow */ }
    }
  };

  // ---------------------------------------------------------------------------
  // Binary payload → base64. Used for ArrayBuffer / Blob / TypedArray frames.
  // ---------------------------------------------------------------------------
  const bytesToBase64 = (uint8) => {
    try {
      // Chunked to avoid stack overflow on large frames via apply().
      let binary = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < uint8.length; i += CHUNK) {
        const slice = uint8.subarray(i, i + CHUNK);
        binary += String.fromCharCode.apply(null, slice);
      }
      return btoa(binary);
    } catch (err) {
      return '';
    }
  };

  // Convert any send/receive payload into a reportable shape.
  // Returns { kind: 'text'|'binary', payload: string }.
  // Blob is async; we read it via FileReader and emit AFTER the frame is sent.
  const normalizePayload = (data, emit) => {
    try {
      if (typeof data === 'string') {
        emit({ kind: 'text', payload: data });
        return;
      }
      if (data instanceof ArrayBuffer) {
        emit({ kind: 'binary', payload: bytesToBase64(new Uint8Array(data)) });
        return;
      }
      if (ArrayBuffer.isView && ArrayBuffer.isView(data)) {
        // TypedArray / DataView
        const view = data.buffer
          ? new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength || 0)
          : new Uint8Array(data);
        emit({ kind: 'binary', payload: bytesToBase64(view) });
        return;
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        // Async: read blob, then emit. We do not block .send().
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const buf = reader.result;
            if (buf instanceof ArrayBuffer) {
              emit({ kind: 'binary', payload: bytesToBase64(new Uint8Array(buf)) });
            } else {
              emit({ kind: 'text', payload: String(buf || '') });
            }
          } catch (_) { /* swallow */ }
        };
        reader.onerror = () => { /* swallow */ };
        try { reader.readAsArrayBuffer(data); } catch (_) { /* swallow */ }
        return;
      }
      // Fallback: stringify whatever it is.
      emit({ kind: 'text', payload: String(data) });
    } catch (err) {
      try {
        // eslint-disable-next-line no-console
        console.warn('[agentscribe-ws] normalizePayload failed:', err && err.message);
      } catch (_) { /* swallow */ }
    }
  };

  const reportFrame = (connection_id, direction, kind, payload) => {
    safePost({
      source: 'agentscribe-ws',
      type: 'frame',
      frame: {
        connection_id,
        direction,
        payload_kind: kind,
        payload,
        timestamp: Date.now()
      }
    });
  };

  const reportConnect = (connection, kind) => {
    safePost({
      source: 'agentscribe-ws',
      type: 'connect',
      connection: {
        id: connection.id,
        url: connection.url,
        protocols: connection.protocols || null,
        kind,
        timestamp: Date.now()
      }
    });
  };

  const reportClose = (connection_id, code, reason) => {
    safePost({
      source: 'agentscribe-ws',
      type: 'close',
      connection_id,
      code: typeof code === 'number' ? code : null,
      reason: typeof reason === 'string' ? reason : '',
      timestamp: Date.now()
    });
  };

  // ===========================================================================
  // 1. WebSocket wrap
  // ===========================================================================
  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    try {
      const WS_PROTO = OriginalWebSocket.prototype;
      const originalSend = WS_PROTO && WS_PROTO.send;

      // onmessage setter descriptor on prototype (lets us hook .onmessage = fn)
      let onmessageDescriptor = null;
      try {
        onmessageDescriptor = Object.getOwnPropertyDescriptor(WS_PROTO, 'onmessage');
      } catch (_) { /* swallow */ }

      const WrappedWebSocket = function WebSocket(url, protocols) {
        let instance;
        try {
          if (protocols === undefined) {
            instance = new OriginalWebSocket(url);
          } else {
            instance = new OriginalWebSocket(url, protocols);
          }
        } catch (err) {
          // Construction failed — re-throw so page sees identical behavior.
          throw err;
        }

        const id = nextConnectionId();

        // Stash metadata on the instance for later reference.
        try {
          Object.defineProperty(instance, '__agentscribe_id', { value: id, enumerable: false });
        } catch (_) { /* swallow */ }

        reportConnect({ id, url: String(url), protocols: protocols || null }, 'websocket');

        // --- Inbound: addEventListener('message')
        try {
          instance.addEventListener('message', (ev) => {
            try {
              normalizePayload(ev && ev.data, ({ kind, payload }) => {
                reportFrame(id, 'inbound', kind, payload);
              });
            } catch (_) { /* swallow */ }
          });
        } catch (_) { /* swallow */ }

        // --- Lifecycle events
        try {
          instance.addEventListener('close', (ev) => {
            try { reportClose(id, ev && ev.code, ev && ev.reason); } catch (_) { /* swallow */ }
          });
        } catch (_) { /* swallow */ }

        try {
          instance.addEventListener('error', () => {
            try {
              safePost({
                source: 'agentscribe-ws',
                type: 'error',
                connection_id: id,
                timestamp: Date.now()
              });
            } catch (_) { /* swallow */ }
          });
        } catch (_) { /* swallow */ }

        return instance;
      };

      // Preserve constructor identity for `instanceof` checks.
      WrappedWebSocket.prototype = OriginalWebSocket.prototype;
      WrappedWebSocket.OPEN = OriginalWebSocket.OPEN;
      WrappedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
      WrappedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
      WrappedWebSocket.CLOSING = OriginalWebSocket.CLOSING;

      // --- Hook .send() on the shared prototype so all instances (including
      //     ones from third-party libraries that grab WebSocket.prototype.send
      //     before our wrap) are captured.
      if (typeof originalSend === 'function') {
        WS_PROTO.send = function send(data) {
          try {
            const id = this && this.__agentscribe_id;
            if (id) {
              normalizePayload(data, ({ kind, payload }) => {
                reportFrame(id, 'outbound', kind, payload);
              });
            }
          } catch (_) { /* swallow */ }
          return originalSend.apply(this, arguments);
        };
      }

      // --- Hook .onmessage setter on the prototype to catch the
      //     `ws.onmessage = fn` pattern. Even when an addEventListener hook
      //     is already in place, we leave the original setter chain intact so
      //     the page's handler still fires.
      if (onmessageDescriptor && typeof onmessageDescriptor.set === 'function') {
        try {
          Object.defineProperty(WS_PROTO, 'onmessage', {
            configurable: true,
            enumerable: onmessageDescriptor.enumerable,
            get: onmessageDescriptor.get,
            set: function (fn) {
              // Call original setter so the page's handler fires normally.
              onmessageDescriptor.set.call(this, fn);
              // No extra capture needed here — addEventListener('message')
              // already covers inbound frames. Setter hook exists so we
              // don't accidentally break .onmessage assignment semantics.
            }
          });
        } catch (_) { /* swallow */ }
      }

      // Replace the global. `prototype` is shared so `instanceof WebSocket`
      // on instances created via the wrapper still passes against either
      // the original or wrapped constructor.
      window.WebSocket = WrappedWebSocket;
    } catch (err) {
      try {
        // eslint-disable-next-line no-console
        console.warn('[agentscribe-ws] WebSocket wrap failed:', err && err.message);
      } catch (_) { /* swallow */ }
    }
  }

  // ===========================================================================
  // 2. EventSource wrap (inbound only — no .send())
  // ===========================================================================
  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === 'function') {
    try {
      const WrappedEventSource = function EventSource(url, eventSourceInitDict) {
        let instance;
        try {
          if (eventSourceInitDict === undefined) {
            instance = new OriginalEventSource(url);
          } else {
            instance = new OriginalEventSource(url, eventSourceInitDict);
          }
        } catch (err) {
          throw err;
        }

        const id = nextConnectionId();

        try {
          Object.defineProperty(instance, '__agentscribe_id', { value: id, enumerable: false });
        } catch (_) { /* swallow */ }

        reportConnect({ id, url: String(url), protocols: null }, 'eventsource');

        // EventSource fires 'message' for unnamed events and custom event names
        // for named ones. We hook the generic 'message' channel — Wave 3 / 4
        // can extend named-event capture if a target site demands it.
        try {
          instance.addEventListener('message', (ev) => {
            try {
              normalizePayload(ev && ev.data, ({ kind, payload }) => {
                reportFrame(id, 'inbound', kind, payload);
              });
            } catch (_) { /* swallow */ }
          });
        } catch (_) { /* swallow */ }

        try {
          instance.addEventListener('error', () => {
            try {
              safePost({
                source: 'agentscribe-ws',
                type: 'error',
                connection_id: id,
                timestamp: Date.now()
              });
            } catch (_) { /* swallow */ }
          });
        } catch (_) { /* swallow */ }

        // EventSource has no 'close' event — we observe readyState transitions
        // via a lightweight timer-free approach: wrap .close().
        try {
          const origClose = instance.close && instance.close.bind(instance);
          if (typeof origClose === 'function') {
            instance.close = function close() {
              try { reportClose(id, null, 'eventsource-close'); } catch (_) { /* swallow */ }
              return origClose();
            };
          }
        } catch (_) { /* swallow */ }

        return instance;
      };

      WrappedEventSource.prototype = OriginalEventSource.prototype;
      WrappedEventSource.CONNECTING = OriginalEventSource.CONNECTING;
      WrappedEventSource.OPEN = OriginalEventSource.OPEN;
      WrappedEventSource.CLOSED = OriginalEventSource.CLOSED;

      window.EventSource = WrappedEventSource;
    } catch (err) {
      try {
        // eslint-disable-next-line no-console
        console.warn('[agentscribe-ws] EventSource wrap failed:', err && err.message);
      } catch (_) { /* swallow */ }
    }
  }

  // Signal ready (Wave 3 can listen for this if it wants to confirm injection).
  safePost({ source: 'agentscribe-ws', type: 'ready', timestamp: Date.now() });
})();
