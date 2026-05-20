import { correlateWsFrames } from '../correlation-engine.js';

export function exportMCP(session) {
  const output = {
    type: 'workflow_recording',
    schema_version: '1.0',
    session_id: session.id,
    recorded_at: session.startTime,
    start_url: session.startUrl,
    summary: {
      total_steps: session.events.filter(e => e.type !== 'scroll').length,
      api_endpoints_discovered: uniqueEndpoints(session.networkEvents),
      injectable_fields: session.injectableFields?.length || 0,
      pages_visited: [...new Set(session.events.map(e => e.url).filter(Boolean))]
    },
    steps: session.events
      .filter(e => ['click', 'input', 'navigation', 'paste'].includes(e.type))
      .map((e, i) => ({
        step: i + 1,
        action: e.type,
        description: describeEvent(e),
        selector: e.element?.cssSelector || null,
        xpath: e.element?.xpath || null,
        value: e.value || null,
        url: e.url,
        api_calls: (e.triggeredRequests || []).map(r => ({
          method: r.method,
          url: r.url,
          payload: r.postData || r.postDataParsed || null,
          status: r.responseStatus,
          is_primary: r.isPrimary
        }))
      })),
    api_map: session.networkEvents
      .filter(n => !isAnalytics(n))
      .map(n => ({
        endpoint: `${n.method} ${n.url}`,
        method: n.method,
        url: n.url,
        payload_schema: inferSchema(n.postDataParsed),
        response_status: n.responseStatus,
        triggered_by_step: n.correlatedToDomEventId
      })),
    injectable_fields: (session.injectableFields || []).map(f => ({
      field_name: f.name || f.id_attr,
      selector: f.cssSelector,
      xpath: f.xpath,
      post_param: f.postParamName,
      form_action: f.formAction,
      form_method: f.formMethod,
      purpose: f.purposeInferred,
      is_sensitive: f.isSensitive
    }))
  };

  // ---------------------------------------------------------------------------
  // v1.0.13 ADDITIVE ENRICHMENTS
  //
  // Every block is wrapped in try/catch — one failing section MUST NOT
  // break the others. v1.0.12 fields above remain untouched.
  // ---------------------------------------------------------------------------

  // auth_state — full hidden-state replay payload
  try {
    output.auth_state = buildAuthState(session);
  } catch (_e) {
    output.auth_state = defaultAuthState();
  }

  // discovered_endpoints — concat across bundleFindings, dedupe
  try {
    output.discovered_endpoints = buildDiscoveredEndpoints(session);
  } catch (_e) {
    output.discovered_endpoints = [];
  }

  // pagination_strategies — keyed by URL pattern, sourced from networkEvents[*].pagination
  try {
    output.pagination_strategies = buildPaginationStrategies(session);
  } catch (_e) {
    output.pagination_strategies = {};
  }

  // semantic_endpoints — keyed by "METHOD URL_PATTERN", DOM-context labels
  try {
    output.semantic_endpoints = buildSemanticEndpoints(session);
  } catch (_e) {
    output.semantic_endpoints = {};
  }

  // challenge_layer — top-level string or null
  try {
    output.challenge_layer = session && typeof session.challengeLayer === 'string'
      ? session.challengeLayer
      : null;
  } catch (_e) {
    output.challenge_layer = null;
  }

  // ws_exchanges — grouped via correlation-engine.correlateWsFrames
  try {
    output.ws_exchanges = buildWsExchanges(session);
  } catch (_e) {
    output.ws_exchanges = [];
  }

  return {
    content: JSON.stringify(output, null, 2),
    filename: `agentscribe-mcp-${Date.now()}.json`,
    mimeType: 'application/json'
  };
}

// =============================================================================
// v1.0.12 helpers (unchanged)
// =============================================================================

function describeEvent(e) {
  if (e.type === 'navigation') return `Navigate to ${e.url}`;
  if (e.type === 'click') {
    const target = e.element?.text || e.element?.ariaLabel || e.element?.id || e.element?.tag || 'element';
    return `Click on ${target}`;
  }
  if (e.type === 'input' || e.type === 'paste') {
    const field = e.element?.name || e.element?.id || e.element?.placeholder || 'field';
    return `${e.type === 'paste' ? 'Paste' : 'Type'} into ${field}`;
  }
  return e.type;
}

function inferSchema(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const schema = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) schema[key] = 'null';
    else if (Array.isArray(value)) schema[key] = 'array';
    else schema[key] = typeof value;
  }
  return schema;
}

function uniqueEndpoints(networkEvents) {
  const set = new Set();
  for (const n of networkEvents) {
    if (!isAnalytics(n)) {
      try { set.add(`${n.method} ${new URL(n.url).pathname}`); }
      catch { set.add(`${n.method} ${n.url}`); }
    }
  }
  return [...set];
}

function isAnalytics(n) {
  const domains = ['analytics', 'metrics', 'telemetry', 'beacon', 'segment.io', 'mixpanel', 'hotjar', 'fullstory', 'quantummetric'];
  return domains.some(d => (n.url || '').toLowerCase().includes(d));
}

// =============================================================================
// v1.0.13 — auth_state builder
// =============================================================================

function defaultAuthState() {
  return {
    cookies: [],
    localStorage: {},
    sessionStorage: {},
    indexedDB: [],
    classified_headers: [],
    auth_scheme: 'none',
    auth_value_source: null,
    expires_at: null,
    jwt_decoded: null,
    refresh_policy: null
  };
}

function buildAuthState(session) {
  const state = defaultAuthState();
  if (!session || typeof session !== 'object') return state;

  // Cookies — last cookieSnapshot wins (most recent state)
  try {
    const snaps = Array.isArray(session.cookieSnapshots) ? session.cookieSnapshots : [];
    if (snaps.length > 0) {
      const last = snaps[snaps.length - 1];
      if (last && Array.isArray(last.cookies)) {
        state.cookies = last.cookies;
      } else if (Array.isArray(last)) {
        state.cookies = last;
      }
    }
  } catch (_e) { /* keep default [] */ }

  // localStorage / sessionStorage / IndexedDB — last storageSnapshot wins
  try {
    const snaps = Array.isArray(session.storageSnapshots) ? session.storageSnapshots : [];
    if (snaps.length > 0) {
      const last = snaps[snaps.length - 1] || {};
      if (last.localStorage && typeof last.localStorage === 'object') {
        state.localStorage = last.localStorage;
      }
      if (last.sessionStorage && typeof last.sessionStorage === 'object') {
        state.sessionStorage = last.sessionStorage;
      }
      if (Array.isArray(last.indexedDB)) {
        // Strip sample values — metadata only per schema
        state.indexedDB = last.indexedDB.map(entry => {
          if (!entry || typeof entry !== 'object') return entry;
          const meta = {};
          if (entry.db !== undefined) meta.db = entry.db;
          if (entry.store !== undefined) meta.store = entry.store;
          if (Array.isArray(entry.keys)) meta.key_count = entry.keys.length;
          else if (typeof entry.key_count === 'number') meta.key_count = entry.key_count;
          return meta;
        });
      }
    }
  } catch (_e) { /* keep defaults */ }

  // classified_headers — pull from session.authProfile.classified_headers if present,
  // otherwise from networkEvents[*].auth_classification.classified_headers (deduped)
  try {
    const fromProfile = session.authProfile && Array.isArray(session.authProfile.classified_headers)
      ? session.authProfile.classified_headers
      : null;
    if (fromProfile && fromProfile.length > 0) {
      state.classified_headers = fromProfile;
    } else {
      const seen = new Set();
      const headers = [];
      const events = Array.isArray(session.networkEvents) ? session.networkEvents : [];
      for (const ev of events) {
        const cls = ev && ev.auth_classification;
        if (!cls) continue;
        const list = Array.isArray(cls.classified_headers) ? cls.classified_headers : [];
        for (const h of list) {
          if (!h || typeof h !== 'object' || typeof h.name !== 'string') continue;
          const key = `${h.name.toLowerCase()}::${h.kind || ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          headers.push(h);
        }
      }
      state.classified_headers = headers;
    }
  } catch (_e) { /* keep default [] */ }

  // Scheme + value source + expires + JWT + refresh policy come from authProfile
  try {
    const profile = session.authProfile;
    if (profile && typeof profile === 'object') {
      if (typeof profile.auth_scheme === 'string') state.auth_scheme = profile.auth_scheme;
      if (typeof profile.auth_value_source === 'string') state.auth_value_source = profile.auth_value_source;

      // expires_at: prefer explicit ms field, then seconds (JWT exp), then jwt_decoded.exp
      if (typeof profile.expires_at === 'number') {
        // Heuristic: JWT exp is seconds; anything < year-3000-seconds is seconds
        state.expires_at = profile.expires_at < 1e12 ? profile.expires_at * 1000 : profile.expires_at;
      } else if (typeof profile.expires_at_ms === 'number') {
        state.expires_at = profile.expires_at_ms;
      } else if (profile.jwt_decoded && typeof profile.jwt_decoded.exp === 'number') {
        state.expires_at = profile.jwt_decoded.exp * 1000;
      }

      if (profile.jwt_decoded && typeof profile.jwt_decoded === 'object') {
        state.jwt_decoded = profile.jwt_decoded;
      }

      // Refresh policy: build from refresh_endpoint_hint + refresh trigger if present
      const refreshEndpoint = profile.refresh_endpoint
        || profile.refresh_endpoint_hint
        || (profile.refresh_policy && profile.refresh_policy.refresh_endpoint)
        || null;
      if (refreshEndpoint) {
        state.refresh_policy = {
          refresh_endpoint: refreshEndpoint,
          method: (profile.refresh_policy && profile.refresh_policy.method) || 'POST',
          trigger: (profile.refresh_policy && profile.refresh_policy.trigger)
            || (state.expires_at ? 'expiry-time' : '401-response')
        };
      }
    }
  } catch (_e) { /* keep defaults */ }

  return state;
}

// =============================================================================
// v1.0.13 — discovered_endpoints builder
// =============================================================================

function buildDiscoveredEndpoints(session) {
  const findings = Array.isArray(session?.bundleFindings) ? session.bundleFindings : [];
  if (findings.length === 0) return [];

  const seen = new Set();
  const out = [];
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    const eps = Array.isArray(finding.discovered_endpoints) ? finding.discovered_endpoints : [];
    for (const ep of eps) {
      if (!ep || typeof ep !== 'object') continue;
      const method = (ep.method || 'GET').toUpperCase();
      const urlPattern = ep.url_pattern || ep.url || '';
      if (!urlPattern) continue;
      const key = `${method}::${urlPattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        method,
        url_pattern: urlPattern,
        source: ep.source || 'bundle_analysis',
        confidence: typeof ep.confidence === 'number' ? ep.confidence : 0.8
      });
    }
  }
  return out;
}

// =============================================================================
// v1.0.13 — pagination_strategies builder
// =============================================================================

function buildPaginationStrategies(session) {
  const events = Array.isArray(session?.networkEvents) ? session.networkEvents : [];
  const strategies = {};

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const pag = ev.pagination;
    if (!pag || typeof pag !== 'object' || !pag.has_pagination) continue;

    let key;
    try {
      key = new URL(ev.url).pathname;
    } catch (_e) {
      key = ev.url || '';
    }
    if (!key) continue;

    // First write wins per endpoint; don't overwrite richer earlier inference
    if (strategies[key]) continue;

    strategies[key] = {
      scheme: pag.scheme || 'cursor',
      cursor_field: pag.cursor_field || null,
      cursor_value_example: pag.cursor_value_example || null
    };
  }

  return strategies;
}

// =============================================================================
// v1.0.13 — semantic_endpoints builder
// =============================================================================
//
// Walks session.events for clicks/inputs immediately followed by mutating
// network calls. The DOM trigger's text/aria-label becomes the label.
function buildSemanticEndpoints(session) {
  const events = Array.isArray(session?.events) ? session.events : [];
  const out = {};

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.type !== 'click' && e.type !== 'input' && e.type !== 'paste') continue;

    const triggers = Array.isArray(e.triggeredRequests) ? e.triggeredRequests : [];
    if (triggers.length === 0) continue;

    const label = e.element?.text
      || e.element?.ariaLabel
      || e.element?.name
      || e.element?.id
      || e.element?.placeholder
      || (e.type === 'click' ? 'Click' : 'Input');

    const triggerLabel = (e.type === 'click')
      ? `${label} click`
      : `${label} ${e.type}`;

    for (const r of triggers) {
      if (!r || typeof r !== 'object') continue;
      const method = (r.method || 'GET').toUpperCase();
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && r.mutates_state !== true) {
        // Skip pure reads unless explicitly tagged as mutating
        continue;
      }
      let urlPattern;
      try { urlPattern = new URL(r.url).pathname; } catch (_e) { urlPattern = r.url || ''; }
      if (!urlPattern) continue;

      const key = `${method} ${urlPattern}`;
      // First click wins per endpoint
      if (out[key]) continue;
      out[key] = {
        label: label,
        triggered_by: triggerLabel
      };
    }
  }

  return out;
}

// =============================================================================
// v1.0.13 — ws_exchanges builder
// =============================================================================

function buildWsExchanges(session) {
  if (!session || typeof session !== 'object') return [];

  const conns = Array.isArray(session.wsConnections) ? session.wsConnections : [];
  const frames = Array.isArray(session.wsFrames) ? session.wsFrames : [];

  if (conns.length === 0 && frames.length === 0) return [];

  // Group exchanges by connection_id via correlation helper
  let allExchanges = [];
  try {
    allExchanges = correlateWsFrames(frames) || [];
  } catch (_e) {
    allExchanges = [];
  }

  // Build connection_id -> exchanges map
  const byConn = new Map();
  for (const ex of allExchanges) {
    const id = ex && ex.connection_id;
    if (id === undefined || id === null) continue;
    if (!byConn.has(id)) byConn.set(id, []);
    byConn.get(id).push(ex);
  }

  // Emit one entry per known connection, plus any orphaned connection_ids
  // that appeared in frames but not in the connections list.
  const seenConns = new Set();
  const out = [];

  for (const c of conns) {
    if (!c || typeof c !== 'object') continue;
    const id = c.connection_id ?? c.id;
    if (id === undefined || id === null) continue;
    seenConns.add(id);
    out.push({
      connection_id: id,
      url: c.url || null,
      exchanges: byConn.get(id) || []
    });
  }

  // Any connection_id present in frames but not in conns list
  for (const [id, exchanges] of byConn) {
    if (seenConns.has(id)) continue;
    out.push({
      connection_id: id,
      url: null,
      exchanges
    });
  }

  return out;
}
