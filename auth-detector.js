// auth-detector.js
// Pure-function authentication classifier for AgentScribe.
// No Chrome APIs, no DOM, no fetch — Node-testable ES module.

// ---------- base64url helpers ----------

function base64UrlDecode(str) {
  if (typeof str !== 'string' || str.length === 0) return null;
  // Convert base64url -> base64
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  // Pad
  const padLen = (4 - (s.length % 4)) % 4;
  s += '='.repeat(padLen);
  try {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(s, 'base64').toString('utf-8');
    }
    // Browser fallback
    if (typeof atob === 'function') {
      const binary = atob(s);
      try {
        // Decode UTF-8 from binary string
        return decodeURIComponent(
          binary
            .split('')
            .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
            .join('')
        );
      } catch {
        return binary;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ---------- JWT decoding ----------

/**
 * Decode a JWT token defensively.
 * Returns { header, payload, exp, iss, aud, raw } or null.
 */
export function decodeJWT(tokenString) {
  if (!tokenString || typeof tokenString !== 'string') return null;

  // Strip leading "Bearer " if accidentally passed
  let token = tokenString.trim();
  if (/^Bearer\s+/i.test(token)) {
    token = token.replace(/^Bearer\s+/i, '').trim();
  }
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;

  const headerJson = base64UrlDecode(h);
  const payloadJson = base64UrlDecode(p);
  if (!headerJson || !payloadJson) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(headerJson);
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }

  if (!header || typeof header !== 'object') return null;
  if (!payload || typeof payload !== 'object') return null;

  return {
    header,
    payload,
    exp: typeof payload.exp === 'number' ? payload.exp : null,
    iss: payload.iss ?? null,
    aud: payload.aud ?? null,
    raw: token,
  };
}

// ---------- Header normalization ----------

function normalizeHeaders(headers) {
  // Accept array of {name,value} (webRequest style) or plain object.
  const out = {};
  if (!headers) return out;
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (h && h.name) out[h.name.toLowerCase()] = h.value;
    }
  } else if (typeof headers === 'object') {
    for (const k of Object.keys(headers)) {
      out[k.toLowerCase()] = headers[k];
    }
  }
  return out;
}

function normalizeCookies(cookies) {
  // Accept array of {name,value} or {name,value,domain,...}
  if (!Array.isArray(cookies)) return [];
  return cookies
    .filter((c) => c && typeof c === 'object' && c.name)
    .map((c) => ({ name: c.name, value: c.value ?? '' }));
}

// ---------- Header classifier ----------

const API_KEY_RE = /^(x-api-key|x-api-token|api-key|apikey|x-auth-token)$/i;
const CSRF_HEADER_RE = /^(x-csrf-token|x-xsrf-token|csrf-token|_csrf|x-csrf)$/i;
const HMAC_HEADER_RE = /^(x-signature|x-hmac|x-hmac-signature|x-auth-hash|x-amz-signature)$/i;
const SESSION_COOKIE_RE = /session|sid|connect\.sid|auth|jsessionid|phpsessid|laravel_session/i;
const CSRF_COOKIE_RE = /_csrf|xsrf-token|csrf_token|csrftoken/i;

/**
 * Classify a single header by name/value.
 */
export function classifyHeader(headerName, headerValue) {
  if (!headerName || typeof headerName !== 'string') {
    return { kind: 'other', metadata: {} };
  }
  const name = headerName.toLowerCase();
  const value = typeof headerValue === 'string' ? headerValue : '';

  if (name === 'authorization') {
    if (/^Bearer\s+/i.test(value)) {
      const token = value.replace(/^Bearer\s+/i, '').trim();
      const jwt = decodeJWT(token);
      if (jwt) {
        return {
          kind: 'bearer-jwt',
          metadata: { token, exp: jwt.exp, iss: jwt.iss, aud: jwt.aud },
        };
      }
      // Bearer but not JWT -> opaque OAuth bearer
      return { kind: 'bearer-jwt', metadata: { token, opaque: true } };
    }
    if (/^Basic\s+/i.test(value)) {
      return { kind: 'other', metadata: { scheme: 'basic' } };
    }
    if (/signature=|hmac/i.test(value)) {
      return { kind: 'hmac-signature', metadata: { raw: value } };
    }
    return { kind: 'other', metadata: { scheme: 'authorization-other', raw: value } };
  }

  if (API_KEY_RE.test(name)) {
    return { kind: 'api-key', metadata: { headerName, length: value.length } };
  }
  if (CSRF_HEADER_RE.test(name)) {
    return { kind: 'csrf', metadata: { headerName } };
  }
  if (HMAC_HEADER_RE.test(name)) {
    return { kind: 'hmac-signature', metadata: { headerName } };
  }
  if (name === 'cookie') {
    return { kind: 'cookie', metadata: { raw: value } };
  }
  return { kind: 'other', metadata: { headerName } };
}

// ---------- refresh endpoint hint ----------

const REFRESH_URL_RE = /refresh|renew|token|auth/i;

/**
 * Score URLs by likelihood of being a refresh endpoint.
 * Input: array of { url, method } OR array of url strings.
 */
export function findRefreshEndpoint(allRequestUrls) {
  if (!Array.isArray(allRequestUrls)) return [];
  const out = [];
  for (const item of allRequestUrls) {
    let url;
    let method;
    if (typeof item === 'string') {
      url = item;
      method = 'GET';
    } else if (item && typeof item === 'object') {
      url = item.url;
      method = (item.method || 'GET').toUpperCase();
    } else {
      continue;
    }
    if (!url || typeof url !== 'string') continue;
    if (!REFRESH_URL_RE.test(url)) continue;
    if (method !== 'POST') continue;

    let score = 0;
    const lower = url.toLowerCase();
    if (/\/refresh\b|refresh_token|refreshtoken/.test(lower)) score += 0.5;
    if (/\/renew\b/.test(lower)) score += 0.4;
    if (/\/auth\/token\b|\/oauth\/token\b|\/token\b/.test(lower)) score += 0.35;
    if (/\/auth\b/.test(lower)) score += 0.15;
    if (score === 0) score = 0.1;
    out.push({ url, method, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------- storage helpers ----------

function findInStorage(storage, predicate) {
  if (!storage || typeof storage !== 'object') return null;
  for (const key of Object.keys(storage)) {
    if (predicate(key, storage[key])) {
      return { key, value: storage[key] };
    }
  }
  return null;
}

const AUTH_STORAGE_KEY_RE = /token|jwt|auth|access|bearer|id_token/i;
const CSRF_STORAGE_KEY_RE = /csrf|xsrf/i;

// ---------- main classifier ----------

/**
 * Classify a request's authentication scheme.
 */
export function classifyRequest({
  headers,
  cookies,
  storageSnapshot,
  url,
  method,
} = {}) {
  const H = normalizeHeaders(headers);
  const C = normalizeCookies(cookies);
  const local = (storageSnapshot && storageSnapshot.localStorage) || {};
  const session = (storageSnapshot && storageSnapshot.sessionStorage) || {};

  let auth_scheme = 'none';
  let auth_value_source = null;
  let jwt_decoded = null;
  let expires_at = null;
  let refresh_endpoint_hint = null;
  let csrf_token_source = null;
  let confidence = 0;

  // Candidate scores so we can resolve "highest confidence" on mixed schemes.
  const candidates = [];

  // 1. Authorization header
  const authHeader = H['authorization'];
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const jwt = decodeJWT(token);
    if (jwt) {
      jwt_decoded = jwt;
      if (jwt.exp) expires_at = jwt.exp * 1000;
      candidates.push({
        scheme: 'jwt-bearer',
        source: 'header:Authorization',
        confidence: 0.98,
      });
    } else {
      candidates.push({
        scheme: 'oauth-bearer',
        source: 'header:Authorization',
        confidence: 0.7,
      });
    }
  } else if (authHeader && /signature=|hmac/i.test(authHeader)) {
    candidates.push({
      scheme: 'hmac-signed',
      source: 'header:Authorization',
      confidence: 0.75,
    });
  }

  // 2. API-key header
  for (const hname of Object.keys(H)) {
    if (API_KEY_RE.test(hname)) {
      candidates.push({
        scheme: 'api-key',
        source: `header:${canonicalHeaderName(hname)}`,
        confidence: 0.9,
      });
      break;
    }
  }

  // 3. HMAC header
  for (const hname of Object.keys(H)) {
    if (HMAC_HEADER_RE.test(hname)) {
      candidates.push({
        scheme: 'hmac-signed',
        source: `header:${canonicalHeaderName(hname)}`,
        confidence: 0.85,
      });
      break;
    }
  }

  // 4. CSRF header
  for (const hname of Object.keys(H)) {
    if (CSRF_HEADER_RE.test(hname)) {
      csrf_token_source = `header:${canonicalHeaderName(hname)}`;
      candidates.push({
        scheme: 'csrf',
        source: csrf_token_source,
        confidence: 0.6,
      });
      break;
    }
  }

  // 5. CSRF cookie
  if (!csrf_token_source) {
    const csrfCookie = C.find((c) => CSRF_COOKIE_RE.test(c.name));
    if (csrfCookie) {
      csrf_token_source = `cookie:${csrfCookie.name}`;
    }
  }

  // 6. Session cookie
  const sessionCookie = C.find(
    (c) => SESSION_COOKIE_RE.test(c.name) && !CSRF_COOKIE_RE.test(c.name)
  );
  if (sessionCookie && !authHeader) {
    candidates.push({
      scheme: 'session-cookie',
      source: `cookie:${sessionCookie.name}`,
      confidence: 0.85,
    });
  } else if (sessionCookie && authHeader) {
    candidates.push({
      scheme: 'session-cookie',
      source: `cookie:${sessionCookie.name}`,
      confidence: 0.4,
    });
  }

  // 7. localStorage token (only relevant if no header-derived auth found yet)
  const localTok = findInStorage(local, (k) => AUTH_STORAGE_KEY_RE.test(k));
  if (localTok && !authHeader) {
    const jwt = decodeJWT(localTok.value);
    if (jwt) {
      jwt_decoded = jwt_decoded || jwt;
      if (!expires_at && jwt.exp) expires_at = jwt.exp * 1000;
      candidates.push({
        scheme: 'jwt-bearer',
        source: `localStorage:${localTok.key}`,
        confidence: 0.55,
      });
    } else {
      candidates.push({
        scheme: 'custom',
        source: `localStorage:${localTok.key}`,
        confidence: 0.3,
      });
    }
  }

  // 8. sessionStorage CSRF
  if (!csrf_token_source) {
    const sCsrf = findInStorage(session, (k) => CSRF_STORAGE_KEY_RE.test(k));
    if (sCsrf) csrf_token_source = `sessionStorage:${sCsrf.key}`;
  }

  // Pick winner = highest confidence candidate
  if (candidates.length > 0) {
    candidates.sort((a, b) => b.confidence - a.confidence);
    const winner = candidates[0];
    auth_scheme = winner.scheme;
    auth_value_source = winner.source;
    confidence = winner.confidence;
  } else if (csrf_token_source) {
    // Only CSRF token found, no other scheme
    auth_scheme = 'csrf';
    auth_value_source = csrf_token_source;
    confidence = 0.4;
  }

  // refresh endpoint hint — only useful if URL looks like one
  if (url && typeof url === 'string' && REFRESH_URL_RE.test(url) && /refresh|renew/i.test(url)) {
    if ((method || '').toUpperCase() === 'POST') {
      refresh_endpoint_hint = extractPath(url);
    }
  }

  return {
    auth_scheme,
    auth_value_source,
    jwt_decoded,
    expires_at,
    refresh_endpoint_hint,
    csrf_token_source,
    confidence,
  };
}

// ---------- utilities ----------

function canonicalHeaderName(lowerName) {
  // Map common lower-case keys back to canonical Hyphen-Case
  const known = {
    'authorization': 'Authorization',
    'x-api-key': 'X-API-Key',
    'x-api-token': 'X-API-Token',
    'api-key': 'API-Key',
    'apikey': 'Apikey',
    'x-auth-token': 'X-Auth-Token',
    'x-csrf-token': 'X-CSRF-Token',
    'x-xsrf-token': 'X-XSRF-Token',
    'csrf-token': 'CSRF-Token',
    '_csrf': '_csrf',
    'x-csrf': 'X-CSRF',
    'x-signature': 'X-Signature',
    'x-hmac': 'X-Hmac',
    'x-hmac-signature': 'X-Hmac-Signature',
    'x-auth-hash': 'X-Auth-Hash',
    'x-amz-signature': 'X-Amz-Signature',
    'cookie': 'Cookie',
  };
  return known[lowerName] || lowerName;
}

function extractPath(url) {
  try {
    const u = new URL(url);
    return u.pathname;
  } catch {
    // Maybe already a path
    if (typeof url === 'string' && url.startsWith('/')) return url;
    return url;
  }
}
