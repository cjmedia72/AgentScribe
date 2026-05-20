// bundle-analyzer.js
// Static-analysis pass over loaded JS bundles.
// Pure-function: takes script content as input, no fetching, no DOM, no chrome.*.
// Node-testable. ES module.
//
// AgentScribe v1.0.13 — Wave 2 · gap inventory rows 10, 11.

const MAX_SOURCE_BYTES = 5 * 1024 * 1024; // 5 MB hard cap per source
const MAX_MATCHES_PER_REGEX = 5000;        // safety cap to keep memory bounded

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isUsableString(s) {
  return typeof s === 'string' && s.length > 0;
}

function lineNumberAt(source, index) {
  if (index <= 0) return 1;
  let line = 1;
  // Avoid splitting whole source — count newlines up to index.
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function pushUnique(arr, value) {
  if (!arr.includes(value)) arr.push(value);
}

function pushUniqueObj(arr, obj, keyFn) {
  const k = keyFn(obj);
  if (!arr.some((existing) => keyFn(existing) === k)) arr.push(obj);
}

function bestMethodNear(source, idx) {
  // Look in a ~120 char window before AND after the literal for a method hint.
  const start = Math.max(0, idx - 120);
  const end = Math.min(source.length, idx + 120);
  const window = source.slice(start, end);

  // axios.post('/x') / fetch(x, { method: 'POST' }) / xhr.open('POST', ...)
  const methodPatterns = [
    /\.(get|post|put|patch|delete|head|options)\s*\(/i,
    /method\s*[:=]\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i,
    /\.open\s*\(\s*['"`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"`]/i,
  ];
  for (const re of methodPatterns) {
    const m = window.match(re);
    if (m && m[1]) return m[1].toUpperCase();
  }
  return 'inferred';
}

function safeExec(re, source, cap = MAX_MATCHES_PER_REGEX) {
  // Generator-style: run exec in a loop with a cap.
  const out = [];
  let m;
  let count = 0;
  re.lastIndex = 0;
  while ((m = re.exec(source)) !== null) {
    out.push(m);
    count++;
    if (count >= cap) break;
    // Defensive: zero-length match → bump lastIndex.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Heuristic scanners (operate on one source string + its URL)
// ---------------------------------------------------------------------------

function scanApiBaseUrls(source, scriptUrl, out) {
  // https?://host/api/v\d+, /api/, /rest/, /v\d+
  const re = /https?:\/\/[a-z0-9.\-]+(?:\/(?:api|rest)(?:\/v\d+)?|\/v\d+)\b/gi;
  for (const m of safeExec(re, source)) {
    pushUnique(out.api_base_urls, m[0]);
  }
}

function scanEndpoints(source, scriptUrl, out) {
  // Match quoted strings containing /api/... or /v\d+/...
  // Cover ', ", ` quoting.
  const re = /(['"`])(\/(?:api|rest)\/[a-z0-9/_:{}.\-]*|\/v\d+\/[a-z0-9/_:{}.\-]*)\1/gi;
  for (const m of safeExec(re, source)) {
    const url_pattern = m[2];
    // Strip trivial bare prefixes like just "/api/" — keep if there's segment content.
    if (url_pattern.length < 5) continue;
    const method = bestMethodNear(source, m.index);
    pushUniqueObj(
      out.discovered_endpoints,
      { method, url_pattern },
      (o) => `${o.method}::${o.url_pattern}`
    );
  }
}

function scanSigningFunctions(source, scriptUrl, out) {
  const patterns = [
    // CryptoJS.HmacSHA256(...) / HmacSHA1 / HmacSHA512 etc.
    { re: /CryptoJS\.HmacSHA(\d+)/g, algoFrom: (m) => `HMAC-SHA${m[1]}` },
    // crypto.createHmac('sha256', ...) — Node-style but sometimes bundled.
    { re: /createHmac\s*\(\s*['"`](sha\d+|md5)['"`]/gi, algoFrom: (m) => `HMAC-${m[1].toUpperCase()}` },
    // crypto.subtle.sign(...) — algo is in a separate arg, mark custom.
    { re: /crypto\.subtle\.sign\s*\(/g, algoFrom: () => 'custom' },
    // crypto.subtle.importKey with HMAC hint.
    { re: /crypto\.subtle\.importKey\s*\([^)]{0,200}HMAC/gi, algoFrom: () => 'HMAC-custom' },
  ];
  for (const { re, algoFrom } of patterns) {
    for (const m of safeExec(re, source)) {
      const algorithm = algoFrom(m);
      const line = lineNumberAt(source, m.index);
      pushUniqueObj(
        out.signing_functions,
        {
          name: m[0].slice(0, 80),
          algorithm,
          location: `${scriptUrl}#L${line}`,
        },
        (o) => `${o.name}::${o.location}`
      );
    }
  }
}

function scanRefreshEndpoints(source, scriptUrl, out) {
  // String literals containing /refresh, /renew, /token, /auth/(refresh|renew|token)
  const re = /(['"`])(\/[a-z0-9/_:{}.\-]*(?:refresh|renew|token)[a-z0-9/_:{}.\-]*)\1/gi;
  for (const m of safeExec(re, source)) {
    const url = m[2];
    // Filter obvious junk: must look path-shaped.
    if (url.length < 6 || url.length > 200) continue;

    // Score: 0.4 base; bump if adjacent to network call markers.
    let confidence = 0.4;
    const start = Math.max(0, m.index - 120);
    const end = Math.min(source.length, m.index + 120);
    const window = source.slice(start, end);
    if (/\bfetch\s*\(/.test(window)) confidence += 0.25;
    if (/axios|XMLHttpRequest|\.open\s*\(/.test(window)) confidence += 0.2;
    if (/grant_type|refresh_token|access_token/.test(window)) confidence += 0.15;
    if (confidence > 1) confidence = 1;

    const line = lineNumberAt(source, m.index);
    pushUniqueObj(
      out.refresh_endpoint_candidates,
      { url, source: `${scriptUrl}#L${line}`, confidence: Number(confidence.toFixed(2)) },
      (o) => `${o.url}::${o.source}`
    );
  }
}

function scanGraphql(source, scriptUrl, out) {
  // Any string ending in /graphql (with optional trailing path bits).
  const re = /(['"`])(\/[a-z0-9/_\-]*graphql[a-z0-9/_\-]*)\1/gi;
  for (const m of safeExec(re, source)) {
    pushUnique(out.graphql_endpoints, m[2]);
  }
  // Also: fetch body containing "query": ... mutation/query — flag a generic marker.
  const bodyRe = /["']query["']\s*:\s*["'`](?:[^"'`\\]|\\.){0,80}(?:mutation|query)\b/gi;
  if (safeExec(bodyRe, source, 8).length > 0) {
    pushUnique(out.graphql_endpoints, '/graphql:inferred-from-body');
  }
}

function scanCsrf(source, scriptUrl, out) {
  // String literals matching /csrf, /csrf-token, /api/csrf
  const re = /(['"`])(\/[a-z0-9/_\-]*csrf[a-z0-9/_\-]*)\1/gi;
  for (const m of safeExec(re, source)) {
    const url = m[2];
    if (url.length < 5 || url.length > 200) continue;
    const line = lineNumberAt(source, m.index);
    pushUniqueObj(
      out.csrf_token_endpoints,
      { url, source: `${scriptUrl}#L${line}` },
      (o) => `${o.url}::${o.source}`
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze a set of JS bundles for API surface intel.
 *
 * @param {Object}   args
 * @param {string[]} args.scriptUrls    URLs (parallel array to scriptSources)
 * @param {string[]} args.scriptSources JS source strings
 * @returns {{
 *   api_base_urls: string[],
 *   discovered_endpoints: {method:string,url_pattern:string}[],
 *   signing_functions: {name:string,algorithm:string,location:string}[],
 *   refresh_endpoint_candidates: {url:string,source:string,confidence:number}[],
 *   graphql_endpoints: string[],
 *   csrf_token_endpoints: {url:string,source:string}[],
 *   warnings: string[]
 * }}
 */
export function analyzeBundle({ scriptUrls, scriptSources } = {}) {
  const out = {
    api_base_urls: [],
    discovered_endpoints: [],
    signing_functions: [],
    refresh_endpoint_candidates: [],
    graphql_endpoints: [],
    csrf_token_endpoints: [],
    warnings: [],
  };

  // Defensive normalization.
  const urls = Array.isArray(scriptUrls) ? scriptUrls : [];
  const sources = Array.isArray(scriptSources) ? scriptSources : [];

  if (sources.length === 0) {
    out.warnings.push('no scriptSources provided');
    return out;
  }

  const n = Math.max(urls.length, sources.length);
  for (let i = 0; i < n; i++) {
    const scriptUrl = typeof urls[i] === 'string' && urls[i] ? urls[i] : `inline:${i}`;
    let source = sources[i];

    if (!isUsableString(source)) {
      out.warnings.push(`skipped non-string source at index ${i} (url=${scriptUrl})`);
      continue;
    }

    // Cap to MAX_SOURCE_BYTES — use byte-ish length via TextEncoder if available, else string length.
    if (source.length > MAX_SOURCE_BYTES) {
      out.warnings.push(`truncated oversized source at index ${i} (${source.length} > ${MAX_SOURCE_BYTES})`);
      source = source.slice(0, MAX_SOURCE_BYTES);
    }

    try {
      scanApiBaseUrls(source, scriptUrl, out);
      scanEndpoints(source, scriptUrl, out);
      scanSigningFunctions(source, scriptUrl, out);
      scanRefreshEndpoints(source, scriptUrl, out);
      scanGraphql(source, scriptUrl, out);
      scanCsrf(source, scriptUrl, out);
    } catch (err) {
      out.warnings.push(`scan failed at index ${i} (${scriptUrl}): ${err && err.message ? err.message : String(err)}`);
    }
  }

  return out;
}

// Default export for convenience.
export default { analyzeBundle };
