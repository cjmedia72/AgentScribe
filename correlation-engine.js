const CORRELATION_WINDOW_MS = 1000;
const WS_EXCHANGE_WINDOW_MS = 2000;

const ANALYTICS_DOMAINS = [
  'analytics', 'metrics', 'telemetry', 'beacon',
  'segment.io', 'mixpanel', 'hotjar', 'fullstory',
  'quantummetric', 'rum.amazonaws.com'
];

// Cursor / pagination field patterns. Order matters: more specific first.
const CURSOR_FIELD_PATTERNS = [
  'nextpagetoken',
  'next_page_token',
  'next_cursor',
  'pagetoken',
  'continuation',
  'cursor',
  '_next',
  'after'
];

// Nested path patterns -- checked against flattened key paths joined by '.'
const NESTED_PAGINATION_PATHS = [
  'pagination.next',
  'links.next',
  'meta.next_page',
  'meta.next',
  'meta.cursor'
];

// Page-number style markers (used when no cursor field found)
const PAGE_NUMBER_FIELDS = ['page', 'pagenumber', 'page_number', 'currentpage', 'current_page'];
const PAGE_NUMBER_COMPANIONS = ['totalpages', 'total_pages', 'pagecount', 'page_count', 'totalcount', 'total_count', 'hasmore', 'has_more', 'hasnext', 'has_next'];

// Mutation method classification
const MUTATION_METHODS = new Set(['DELETE', 'POST', 'PUT', 'PATCH']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Fields whose presence on a top-level response object suggests the response
// reflects a created/updated resource (i.e. genuine mutation).
const MUTATION_RESULT_FIELDS = ['id', 'created', 'updated', 'status', 'createdAt', 'updatedAt', 'created_at', 'updated_at'];

export function correlate(domEvents, networkEvents, windowMs) {
  const window_ = windowMs || CORRELATION_WINDOW_MS;
  const correlated = [...networkEvents];

  correlated.forEach(netEvent => {
    const windowStart = netEvent.timestamp - window_;
    const candidates = domEvents.filter(
      d => d.timestamp >= windowStart && d.timestamp <= netEvent.timestamp
    );

    const trigger = candidates[candidates.length - 1] || null;

    if (trigger) {
      netEvent.correlatedToDomEventId = trigger.id;
      if (!trigger.triggeredRequests) trigger.triggeredRequests = [];
      trigger.triggeredRequests.push({
        requestId: netEvent.requestId,
        url: netEvent.url,
        method: netEvent.method,
        postData: netEvent.postData,
        postDataParsed: netEvent.postDataParsed,
        responseStatus: netEvent.responseStatus,
        isPrimary: isPrimaryRequest(netEvent),
        isAnalytics: isAnalyticsRequest(netEvent)
      });
    } else {
      netEvent.correlatedToDomEventId = null;
      netEvent.isBackgroundRequest = true;
    }
  });

  return { domEvents, networkEvents: correlated };
}

function isPrimaryRequest(netEvent) {
  return !isAnalyticsRequest(netEvent) &&
    ['XHR', 'Fetch'].includes(netEvent.resourceType) &&
    ['POST', 'PUT', 'DELETE', 'GET'].includes(netEvent.method);
}

function isAnalyticsRequest(netEvent) {
  return ANALYTICS_DOMAINS.some(d => netEvent.url.toLowerCase().includes(d));
}

// -----------------------------------------------------------------------------
// WebSocket frame correlation
// -----------------------------------------------------------------------------
//
// Groups WS frames into "exchanges": one initiating frame followed by 1+
// reply frames in the opposite direction within `windowMs`. Works for both
// client-initiated (outbound -> inbound replies) and server-initiated
// (inbound -> outbound replies) flows.
//
// Frame shape (lenient): { connection_id, direction: 'outbound'|'inbound',
//                          timestamp, payload }
//
// Returns: [{ connection_id, request_frame, response_frames, timing_ms }]
//
// Exchanges that never receive a reply are still emitted with
// response_frames=[] and timing_ms=null so callers can see unanswered sends.
export function correlateWsFrames(wsFrames, windowMs) {
  const window_ = windowMs || WS_EXCHANGE_WINDOW_MS;
  if (!Array.isArray(wsFrames) || wsFrames.length === 0) return [];

  // Group by connection_id
  const byConn = new Map();
  for (const frame of wsFrames) {
    if (!frame || typeof frame !== 'object') continue;
    const id = frame.connection_id;
    if (id === undefined || id === null) continue;
    if (!byConn.has(id)) byConn.set(id, []);
    byConn.get(id).push(frame);
  }

  const exchanges = [];

  for (const [connId, frames] of byConn) {
    // Sort by timestamp ascending. Frames with no timestamp sink to end.
    const sorted = frames.slice().sort((a, b) => {
      const ta = typeof a.timestamp === 'number' ? a.timestamp : Infinity;
      const tb = typeof b.timestamp === 'number' ? b.timestamp : Infinity;
      return ta - tb;
    });

    const consumed = new Set();

    for (let i = 0; i < sorted.length; i++) {
      if (consumed.has(i)) continue;
      const req = sorted[i];
      if (!req.direction) continue;

      consumed.add(i);
      const responses = [];
      const oppositeDir = req.direction === 'outbound' ? 'inbound' : 'outbound';
      const reqTs = typeof req.timestamp === 'number' ? req.timestamp : null;

      for (let j = i + 1; j < sorted.length; j++) {
        if (consumed.has(j)) continue;
        const candidate = sorted[j];
        if (candidate.direction !== oppositeDir) {
          // Same-direction frame after our initiator breaks the exchange.
          // (Next iteration will pick it up as its own initiator.)
          break;
        }
        const candTs = typeof candidate.timestamp === 'number' ? candidate.timestamp : null;
        if (reqTs !== null && candTs !== null && (candTs - reqTs) > window_) break;
        responses.push(candidate);
        consumed.add(j);
      }

      let timingMs = null;
      if (responses.length > 0 && reqTs !== null) {
        const lastTs = typeof responses[responses.length - 1].timestamp === 'number'
          ? responses[responses.length - 1].timestamp
          : null;
        if (lastTs !== null) timingMs = lastTs - reqTs;
      }

      exchanges.push({
        connection_id: connId,
        request_frame: req,
        response_frames: responses,
        timing_ms: timingMs
      });
    }
  }

  return exchanges;
}

// -----------------------------------------------------------------------------
// Response-shape inspector / pagination inference
// -----------------------------------------------------------------------------
//
// Returns { has_pagination, cursor_field, cursor_value_example, scheme }
//   scheme: 'cursor' | 'page-number' | 'link-header' | null
//
// Looks at networkEvent.responseBodyParsed first (already-parsed object);
// falls back to JSON.parse(networkEvent.responseBody) if needed; falls back
// further to a regex pass on the raw string. Also inspects responseHeaders
// for an RFC 5988 `Link: <...>; rel="next"` header.
export function inferPagination(networkEvent) {
  const result = {
    has_pagination: false,
    cursor_field: null,
    cursor_value_example: null,
    scheme: null
  };

  if (!networkEvent || typeof networkEvent !== 'object') return result;

  // 1) Link: rel="next" header (RFC 5988)
  const linkHeader = findLinkHeader(networkEvent.responseHeaders);
  if (linkHeader && /rel\s*=\s*"?next"?/i.test(linkHeader)) {
    result.has_pagination = true;
    result.scheme = 'link-header';
    result.cursor_field = 'Link';
    const m = linkHeader.match(/<([^>]+)>\s*;\s*rel\s*=\s*"?next"?/i);
    if (m) result.cursor_value_example = m[1];
    // Link header is authoritative -- return early.
    return result;
  }

  // 2) Get a parsed body if possible
  let body = networkEvent.responseBodyParsed;
  if (body === undefined || body === null) {
    if (typeof networkEvent.responseBody === 'string' && networkEvent.responseBody.length > 0) {
      try {
        body = JSON.parse(networkEvent.responseBody);
      } catch (_e) {
        body = null;
      }
    }
  }

  if (body && typeof body === 'object') {
    // 2a) Walk top-level + one level of nesting, looking for cursor fields
    const flat = flattenKeys(body, 2);

    // Cursor scheme: known cursor field name match
    for (const path of Object.keys(flat)) {
      const lower = path.toLowerCase();
      const leaf = lower.split('.').pop();
      if (CURSOR_FIELD_PATTERNS.includes(leaf) || CURSOR_FIELD_PATTERNS.includes(lower)) {
        const val = flat[path];
        if (val !== null && val !== undefined && val !== '' && val !== false) {
          result.has_pagination = true;
          result.scheme = 'cursor';
          result.cursor_field = path;
          result.cursor_value_example = safeStringValue(val);
          return result;
        }
      }
      if (NESTED_PAGINATION_PATHS.includes(lower)) {
        const val = flat[path];
        if (val !== null && val !== undefined && val !== '') {
          result.has_pagination = true;
          result.scheme = 'cursor';
          result.cursor_field = path;
          result.cursor_value_example = safeStringValue(val);
          return result;
        }
      }
    }

    // Page-number scheme: page/pageNumber + companion (total/hasMore/etc.)
    const lowerKeys = Object.keys(flat).map(k => k.toLowerCase());
    const hasPageField = lowerKeys.some(k => PAGE_NUMBER_FIELDS.includes(k.split('.').pop()));
    const hasCompanion = lowerKeys.some(k => PAGE_NUMBER_COMPANIONS.includes(k.split('.').pop()));
    if (hasPageField && hasCompanion) {
      // Pick the first page field as cursor_field
      const pageKey = Object.keys(flat).find(k => PAGE_NUMBER_FIELDS.includes(k.toLowerCase().split('.').pop()));
      result.has_pagination = true;
      result.scheme = 'page-number';
      result.cursor_field = pageKey || null;
      if (pageKey) result.cursor_value_example = safeStringValue(flat[pageKey]);
      return result;
    }
  }

  // 3) Last-ditch raw-string regex (covers non-JSON bodies, e.g. JSONP)
  if (typeof networkEvent.responseBody === 'string' && networkEvent.responseBody.length > 0) {
    try {
      const re = /"(nextPageToken|next_page_token|next_cursor|continuation|pageToken|_next|cursor|after)"\s*:\s*"([^"]+)"/i;
      const m = networkEvent.responseBody.match(re);
      if (m) {
        result.has_pagination = true;
        result.scheme = 'cursor';
        result.cursor_field = m[1];
        result.cursor_value_example = m[2];
      }
    } catch (_e) { /* swallow */ }
  }

  return result;
}

function findLinkHeader(headers) {
  if (!headers) return null;
  // Headers may be array of {name,value} or plain object
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h && typeof h.name === 'string' && h.name.toLowerCase() === 'link') return h.value || null;
    }
    return null;
  }
  if (typeof headers === 'object') {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'link') return headers[k];
    }
  }
  return null;
}

// Flatten an object's keys down to `maxDepth` levels. Returns a flat map
// of dotted-path -> leaf value (only primitives recorded as leaves).
function flattenKeys(obj, maxDepth) {
  const out = {};
  function walk(node, prefix, depth) {
    if (node === null || node === undefined) return;
    if (depth > maxDepth) return;
    if (typeof node !== 'object') {
      out[prefix] = node;
      return;
    }
    if (Array.isArray(node)) {
      // Record the array itself at this path (so e.g. "links.next" if it's a string array can be inspected),
      // but don't recurse into element indices for pagination detection.
      return;
    }
    for (const key of Object.keys(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const val = node[key];
      if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        walk(val, path, depth + 1);
      } else {
        out[path] = val;
      }
    }
  }
  try {
    walk(obj, '', 0);
  } catch (_e) { /* swallow */ }
  return out;
}

function safeStringValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > 256 ? v.slice(0, 256) + '...' : v;
  try { return String(v); } catch (_e) { return null; }
}

// -----------------------------------------------------------------------------
// Mutation detector
// -----------------------------------------------------------------------------
//
// Returns a boolean. Caller assigns to event (we don't mutate).
//
// Rule:
//   - GET/HEAD/OPTIONS -> false
//   - DELETE/POST/PUT/PATCH -> true UNLESS response body strongly suggests a read
//     (top-level array, or a top-level object with NONE of id/created/updated/status/*At).
//   - Unknown method -> false (safe default; never guess a mutation)
export function tagMutation(networkEvent) {
  if (!networkEvent || typeof networkEvent !== 'object') return false;
  const method = (networkEvent.method || '').toUpperCase();

  if (READ_METHODS.has(method)) return false;
  if (!MUTATION_METHODS.has(method)) return false;

  // Default: mutation methods mutate.
  // Override only if the response body looks unmistakably like a read.
  let body = networkEvent.responseBodyParsed;
  if (body === undefined || body === null) {
    if (typeof networkEvent.responseBody === 'string' && networkEvent.responseBody.length > 0) {
      try { body = JSON.parse(networkEvent.responseBody); } catch (_e) { body = null; }
    }
  }

  if (body !== null && body !== undefined) {
    // Top-level array -> looks like a list/read result
    if (Array.isArray(body)) return false;

    if (typeof body === 'object') {
      const keys = Object.keys(body).map(k => k.toLowerCase());
      if (keys.length === 0) return true; // empty object after a POST = still a mutation (no-op create returns {})
      const hasMutationMarker = keys.some(k => MUTATION_RESULT_FIELDS.map(f => f.toLowerCase()).includes(k));
      if (!hasMutationMarker) {
        // POST that returned an object with no id/created/updated/status -- likely a search/read endpoint
        // (e.g. POST /search { results: [...] }).
        return false;
      }
    }
  }

  return true;
}
