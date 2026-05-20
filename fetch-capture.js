/*
 * AgentScribe fetch-capture.js
 *
 * Page-context proxy for window.fetch and XMLHttpRequest.
 * MUST be injected into the page's MAIN world (not the isolated extension
 * world) so it can intercept the page's own network calls -- specifically
 * those served by a ServiceWorker from CacheStorage which never hit
 * chrome.webRequest or CDP's Network domain.
 *
 * v1.0.13 Wave 6 hotfix.
 *
 * Reports to the content script via window.postMessage with envelope:
 *   { source: 'agentscribe-fetch', ...payload }
 *
 * content.js listens for these and forwards to background as FETCH_EVENT.
 *
 * Defensive guarantees:
 *   - NEVER mutate the page's request/response semantics. We chain the
 *     original calls and never throw.
 *   - NEVER block the page. Response body reads happen on a cloned response,
 *     fully async; we don't await before returning to the page.
 *   - Bounded payloads: body strings are truncated to a per-frame ceiling.
 *   - Idempotent: re-injection (e.g. SPA navigations triggering a re-inject)
 *     is a no-op via window.__agentscribe_fetch_capture_loaded.
 */

(() => {
  'use strict';

  if (window.__agentscribe_fetch_capture_loaded) return;
  window.__agentscribe_fetch_capture_loaded = true;

  // ---------------------------------------------------------------------------
  // Constants / limits
  // ---------------------------------------------------------------------------
  const BODY_BYTE_LIMIT = 256 * 1024; // 256KB per direction per call
  const HEADER_BYTE_LIMIT = 16 * 1024;

  // ---------------------------------------------------------------------------
  // Request ID counter (monotonic, scoped to this injection)
  // ---------------------------------------------------------------------------
  let __reqSeq = 0;
  const nextRequestId = (api) => {
    __reqSeq += 1;
    return (api === 'xhr' ? 'xhr-' : 'fetch-') + Date.now().toString(36) + '-' + __reqSeq;
  };

  // ---------------------------------------------------------------------------
  // Safe postMessage
  // ---------------------------------------------------------------------------
  const safePost = (msg) => {
    try {
      window.postMessage(msg, '*');
    } catch (err) {
      try {
        // eslint-disable-next-line no-console
        console.warn('[agentscribe-fetch] postMessage failed:', err && err.message);
      } catch (_) { /* swallow */ }
    }
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const truncate = (s, limit) => {
    if (s == null) return s;
    if (typeof s !== 'string') {
      try { s = String(s); } catch (_) { return null; }
    }
    return s.length > limit ? s.slice(0, limit) + '...[truncated]' : s;
  };

  const headersToObject = (h) => {
    try {
      if (!h) return null;
      // Headers instance
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        const out = {};
        h.forEach((v, k) => { out[k] = v; });
        return out;
      }
      // Plain object
      if (typeof h === 'object' && !Array.isArray(h)) {
        const out = {};
        for (const k of Object.keys(h)) { out[k] = String(h[k]); }
        return out;
      }
      // Array of [k, v] pairs
      if (Array.isArray(h)) {
        const out = {};
        for (const pair of h) {
          if (Array.isArray(pair) && pair.length >= 2) out[pair[0]] = String(pair[1]);
        }
        return out;
      }
      return null;
    } catch (_) { return null; }
  };

  const stringifyBody = async (body) => {
    try {
      if (body == null) return null;
      if (typeof body === 'string') return truncate(body, BODY_BYTE_LIMIT);
      if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
        return truncate(body.toString(), BODY_BYTE_LIMIT);
      }
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        const parts = [];
        try {
          body.forEach((value, key) => {
            if (typeof value === 'string') parts.push(`${key}=${value}`);
            else parts.push(`${key}=[file]`);
          });
        } catch (_) { /* swallow */ }
        return truncate(parts.join('&'), BODY_BYTE_LIMIT);
      }
      if (body instanceof ArrayBuffer) {
        return `[binary ${body.byteLength}b]`;
      }
      if (ArrayBuffer.isView && ArrayBuffer.isView(body)) {
        return `[binary ${body.byteLength || body.buffer?.byteLength || 0}b]`;
      }
      if (typeof Blob !== 'undefined' && body instanceof Blob) {
        try {
          const text = await body.slice(0, BODY_BYTE_LIMIT).text();
          return truncate(text, BODY_BYTE_LIMIT);
        } catch (_) { return `[blob ${body.size || 0}b]`; }
      }
      if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) {
        return '[stream]';
      }
      // Fallback: stringify
      try { return truncate(JSON.stringify(body), BODY_BYTE_LIMIT); }
      catch (_) { return truncate(String(body), BODY_BYTE_LIMIT); }
    } catch (_) { return null; }
  };

  // ===========================================================================
  // 1. window.fetch wrap
  // ===========================================================================
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    try {
      window.fetch = function fetch(input, init) {
        const requestId = nextRequestId('fetch');
        const startTs = Date.now();
        let method = 'GET';
        let url = null;
        let reqHeaders = null;
        let reqBody = null;

        try {
          // input can be a Request, a URL string, or a URL object.
          if (typeof Request !== 'undefined' && input instanceof Request) {
            url = input.url;
            method = input.method || 'GET';
            reqHeaders = headersToObject(input.headers);
            // Note: we cannot easily read the Request body without consuming
            // it. Skip body capture for Request inputs -- init.body is the
            // common case anyway.
          } else if (typeof input === 'string') {
            url = input;
          } else if (input && typeof input === 'object' && input.url) {
            url = String(input.url);
          } else {
            try { url = String(input); } catch (_) { url = null; }
          }

          if (init && typeof init === 'object') {
            if (init.method) method = String(init.method);
            if (init.headers) reqHeaders = headersToObject(init.headers) || reqHeaders;
          }
        } catch (_) { /* swallow */ }

        // Async body capture (non-blocking)
        const bodyPromise = (init && init.body !== undefined && init.body !== null)
          ? stringifyBody(init.body).catch(() => null)
          : Promise.resolve(null);

        bodyPromise.then((bodyStr) => {
          safePost({
            source: 'agentscribe-fetch',
            api: 'fetch',
            phase: 'request',
            requestId,
            timestamp: startTs,
            url,
            method: String(method || 'GET').toUpperCase(),
            requestHeaders: reqHeaders,
            requestBody: bodyStr
          });
        }).catch(() => { /* swallow */ });

        // Chain the original fetch -- preserve all behavior.
        let respPromise;
        try {
          respPromise = originalFetch.apply(this, arguments);
        } catch (syncErr) {
          // Some implementations may throw synchronously; surface as error event.
          try {
            safePost({
              source: 'agentscribe-fetch',
              api: 'fetch',
              phase: 'error',
              requestId,
              timestamp: Date.now(),
              url,
              method: String(method || 'GET').toUpperCase(),
              error: (syncErr && syncErr.message) || String(syncErr)
            });
          } catch (_) { /* swallow */ }
          throw syncErr;
        }

        return respPromise.then((response) => {
          // Clone for async body read; never block the page on the original.
          let cloned = null;
          try { cloned = response.clone(); } catch (_) { cloned = null; }

          const respStatus = response && response.status;
          const respHeaders = response && headersToObject(response.headers);

          // Read clone body asynchronously, post when done. Do NOT await.
          if (cloned) {
            cloned.text().then((text) => {
              safePost({
                source: 'agentscribe-fetch',
                api: 'fetch',
                phase: 'response',
                requestId,
                timestamp: Date.now(),
                url,
                method: String(method || 'GET').toUpperCase(),
                responseStatus: respStatus,
                responseHeaders: respHeaders,
                responseBody: truncate(text, BODY_BYTE_LIMIT)
              });
            }).catch(() => {
              safePost({
                source: 'agentscribe-fetch',
                api: 'fetch',
                phase: 'response',
                requestId,
                timestamp: Date.now(),
                url,
                method: String(method || 'GET').toUpperCase(),
                responseStatus: respStatus,
                responseHeaders: respHeaders,
                responseBody: null
              });
            });
          } else {
            safePost({
              source: 'agentscribe-fetch',
              api: 'fetch',
              phase: 'response',
              requestId,
              timestamp: Date.now(),
              url,
              method: String(method || 'GET').toUpperCase(),
              responseStatus: respStatus,
              responseHeaders: respHeaders,
              responseBody: null
            });
          }

          return response;
        }).catch((err) => {
          try {
            safePost({
              source: 'agentscribe-fetch',
              api: 'fetch',
              phase: 'error',
              requestId,
              timestamp: Date.now(),
              url,
              method: String(method || 'GET').toUpperCase(),
              error: (err && err.message) || String(err)
            });
          } catch (_) { /* swallow */ }
          throw err;
        });
      };
    } catch (err) {
      try {
        // eslint-disable-next-line no-console
        console.warn('[agentscribe-fetch] fetch wrap failed:', err && err.message);
      } catch (_) { /* swallow */ }
    }
  }

  // ===========================================================================
  // 2. XMLHttpRequest wrap
  // ===========================================================================
  const XHRProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHRProto && typeof XHRProto.open === 'function' && typeof XHRProto.send === 'function') {
    try {
      const originalOpen = XHRProto.open;
      const originalSend = XHRProto.send;
      const originalSetHeader = XHRProto.setRequestHeader;

      XHRProto.open = function open(method, url, async, user, password) {
        try {
          if (!this.__agentscribe_xhr) {
            Object.defineProperty(this, '__agentscribe_xhr', {
              value: {
                requestId: nextRequestId('xhr'),
                method: String(method || 'GET').toUpperCase(),
                url: String(url || ''),
                headers: {},
                startTs: null,
                reported: false
              },
              enumerable: false,
              writable: true,
              configurable: true
            });
          } else {
            this.__agentscribe_xhr.method = String(method || 'GET').toUpperCase();
            this.__agentscribe_xhr.url = String(url || '');
            this.__agentscribe_xhr.headers = {};
            this.__agentscribe_xhr.startTs = null;
            this.__agentscribe_xhr.reported = false;
          }
        } catch (_) { /* swallow */ }
        return originalOpen.apply(this, arguments);
      };

      XHRProto.setRequestHeader = function setRequestHeader(name, value) {
        try {
          const meta = this.__agentscribe_xhr;
          if (meta) {
            meta.headers[String(name)] = String(value);
          }
        } catch (_) { /* swallow */ }
        return originalSetHeader.apply(this, arguments);
      };

      const reportXhrResponse = (xhr) => {
        try {
          const meta = xhr.__agentscribe_xhr;
          if (!meta || meta.reported) return;
          meta.reported = true;

          let respHeaders = null;
          try {
            const raw = xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : '';
            if (raw) {
              const obj = {};
              raw.split(/\r?\n/).forEach((line) => {
                const idx = line.indexOf(':');
                if (idx > 0) {
                  const k = line.slice(0, idx).trim();
                  const v = line.slice(idx + 1).trim();
                  if (k) obj[k] = v;
                }
              });
              respHeaders = obj;
            }
          } catch (_) { /* swallow */ }

          let respBody = null;
          try {
            // responseType '' or 'text' -> responseText is safe to read
            const rt = xhr.responseType;
            if (rt === '' || rt === 'text') {
              respBody = truncate(xhr.responseText || '', BODY_BYTE_LIMIT);
            } else if (rt === 'json') {
              try { respBody = truncate(JSON.stringify(xhr.response), BODY_BYTE_LIMIT); }
              catch (_) { respBody = null; }
            } else if (rt === 'arraybuffer') {
              respBody = `[binary ${(xhr.response && xhr.response.byteLength) || 0}b]`;
            } else if (rt === 'blob') {
              respBody = `[blob ${(xhr.response && xhr.response.size) || 0}b]`;
            } else if (rt === 'document') {
              respBody = '[document]';
            }
          } catch (_) { /* swallow */ }

          safePost({
            source: 'agentscribe-fetch',
            api: 'xhr',
            phase: 'response',
            requestId: meta.requestId,
            timestamp: Date.now(),
            url: meta.url,
            method: meta.method,
            responseStatus: xhr.status,
            responseHeaders: respHeaders,
            responseBody: respBody
          });
        } catch (_) { /* swallow */ }
      };

      XHRProto.send = function send(body) {
        try {
          const meta = this.__agentscribe_xhr;
          if (meta) {
            meta.startTs = Date.now();

            // Async body stringify (non-blocking)
            stringifyBody(body).then((bodyStr) => {
              safePost({
                source: 'agentscribe-fetch',
                api: 'xhr',
                phase: 'request',
                requestId: meta.requestId,
                timestamp: meta.startTs,
                url: meta.url,
                method: meta.method,
                requestHeaders: meta.headers,
                requestBody: bodyStr
              });
            }).catch(() => { /* swallow */ });

            // Hook load via addEventListener (covers most cases).
            try {
              this.addEventListener('load', () => reportXhrResponse(this));
            } catch (_) { /* swallow */ }

            try {
              this.addEventListener('error', () => {
                try {
                  if (meta.reported) return;
                  meta.reported = true;
                  safePost({
                    source: 'agentscribe-fetch',
                    api: 'xhr',
                    phase: 'error',
                    requestId: meta.requestId,
                    timestamp: Date.now(),
                    url: meta.url,
                    method: meta.method,
                    error: 'xhr error event'
                  });
                } catch (_) { /* swallow */ }
              });
            } catch (_) { /* swallow */ }

            try {
              this.addEventListener('abort', () => {
                try {
                  if (meta.reported) return;
                  meta.reported = true;
                  safePost({
                    source: 'agentscribe-fetch',
                    api: 'xhr',
                    phase: 'error',
                    requestId: meta.requestId,
                    timestamp: Date.now(),
                    url: meta.url,
                    method: meta.method,
                    error: 'xhr aborted'
                  });
                } catch (_) { /* swallow */ }
              });
            } catch (_) { /* swallow */ }

            // Hook the legacy onload setter so handlers assigned via
            // xhr.onload = fn don't bypass our reporter. We wrap the existing
            // setter so the page's assignment still fires.
            try {
              const desc = Object.getOwnPropertyDescriptor(XHRProto, 'onload')
                        || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), 'onload');
              if (desc && typeof desc.set === 'function' && !this.__agentscribe_xhr.onloadHooked) {
                this.__agentscribe_xhr.onloadHooked = true;
                const origSet = desc.set;
                const origGet = desc.get;
                Object.defineProperty(this, 'onload', {
                  configurable: true,
                  enumerable: true,
                  get: function () { return origGet ? origGet.call(this) : undefined; },
                  set: function (fn) {
                    const wrapped = function () {
                      try { reportXhrResponse(this); } catch (_) { /* swallow */ }
                      if (typeof fn === 'function') {
                        try { return fn.apply(this, arguments); } catch (_) { /* swallow */ }
                      }
                    };
                    origSet.call(this, wrapped);
                  }
                });
              }
            } catch (_) { /* swallow */ }
          }
        } catch (_) { /* swallow */ }

        return originalSend.apply(this, arguments);
      };
    } catch (err) {
      try {
        // eslint-disable-next-line no-console
        console.warn('[agentscribe-fetch] XHR wrap failed:', err && err.message);
      } catch (_) { /* swallow */ }
    }
  }

  // Signal ready
  safePost({ source: 'agentscribe-fetch', type: 'ready', timestamp: Date.now() });
})();
