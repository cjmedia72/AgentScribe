export function exportPostman(session) {
  const endpoints = deduplicateEndpoints(session.networkEvents);
  const grouped = groupByDomain(endpoints);

  const authProfile = session.authProfile || null;
  const usedVars = new Set();

  const collection = {
    info: {
      name: `AgentScribe — ${session.name || session.startUrl}`,
      description: `Recorded ${new Date(session.startTime).toISOString()} | ${session.networkEvents.length} API calls captured`,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
    },
    item: grouped.map(group => ({
      name: group.domain,
      item: group.requests.map(req => ({
        name: `${req.method} ${safePath(req.url)}`,
        request: {
          method: req.method,
          header: Object.entries(req.headers || {})
            .filter(([k]) => !k.toLowerCase().startsWith(':'))
            .map(([key, value]) => ({
              key,
              value: substituteAuthInHeader(key, String(value), authProfile, usedVars)
            })),
          url: parsePostmanUrl(req.url),
          ...(req.postData ? {
            body: {
              mode: 'raw',
              raw: typeof req.postData === 'string' ? req.postData : JSON.stringify(req.postData, null, 2),
              options: { raw: { language: 'json' } }
            }
          } : {})
        },
        response: [{
          name: 'Captured Response',
          originalRequest: {
            method: req.method,
            url: parsePostmanUrl(req.url)
          },
          status: statusText(req.responseStatus),
          code: req.responseStatus,
          body: req.responseBody || ''
        }]
      }))
    }))
  };

  // OAuth pre-request script (collection-level event) for oauth-bearer flows
  if (authProfile && authProfile.auth_scheme === 'oauth-bearer') {
    const refreshUrl = (authProfile.refresh_endpoint_candidates && authProfile.refresh_endpoint_candidates[0]) || '';
    collection.event = [
      {
        listen: 'prerequest',
        script: {
          type: 'text/javascript',
          exec: buildOAuthPrerequestScript(refreshUrl)
        }
      }
    ];
    usedVars.add('auth_token');
    if (refreshUrl) {
      usedVars.add('refresh_url');
      usedVars.add('refresh_token');
      usedVars.add('token_expires_at');
    }
  }

  const result = {
    content: JSON.stringify(collection, null, 2),
    filename: `agentscribe-postman-${Date.now()}.json`,
    mimeType: 'application/json'
  };

  // Companion environment file — only when authProfile present (defensive)
  if (authProfile && usedVars.size > 0) {
    const envFile = buildEnvironmentFile(session, authProfile, usedVars);
    result.environmentFile = envFile;
  }

  return result;
}

// Replace literal auth value in a header with a Postman variable reference
// when authProfile.auth_value_source identifies this header/cookie as the auth carrier.
function substituteAuthInHeader(headerKey, headerValue, authProfile, usedVars) {
  if (!authProfile || !authProfile.auth_value_source) return headerValue;
  const src = authProfile.auth_value_source; // e.g. "header:Authorization" | "cookie:_session_id" | "header:X-API-Key"
  const keyLower = headerKey.toLowerCase();
  const scheme = authProfile.auth_scheme;

  // Cookie header — substitute the matching cookie name in a multi-cookie string
  if (keyLower === 'cookie') {
    return substituteCookieHeader(headerValue, authProfile, usedVars);
  }

  // header:<Name> source
  if (src.startsWith('header:')) {
    const targetHeader = src.slice('header:'.length).toLowerCase();
    if (keyLower !== targetHeader) return headerValue;

    // Map auth_scheme → Postman var name
    if (keyLower === 'authorization') {
      // Bearer token (oauth-bearer or jwt-bearer)
      if (/^bearer\s+/i.test(headerValue)) {
        usedVars.add('auth_token');
        return 'Bearer {{auth_token}}';
      }
      // Other Authorization schemes — preserve scheme prefix if any, swap value
      const m = headerValue.match(/^(\S+)\s+(.+)$/);
      if (m) {
        usedVars.add('auth_token');
        return `${m[1]} {{auth_token}}`;
      }
      usedVars.add('auth_token');
      return '{{auth_token}}';
    }

    if (keyLower === 'x-api-key' || keyLower === 'x-auth-token') {
      usedVars.add('api_key');
      return '{{api_key}}';
    }

    if (keyLower === 'x-csrf-token' || keyLower === 'x-xsrf-token') {
      usedVars.add('csrf_token');
      return '{{csrf_token}}';
    }

    // Generic custom auth header — fall back to auth_token
    if (scheme === 'csrf') {
      usedVars.add('csrf_token');
      return '{{csrf_token}}';
    }
    if (scheme === 'api-key') {
      usedVars.add('api_key');
      return '{{api_key}}';
    }
    usedVars.add('auth_token');
    return '{{auth_token}}';
  }

  return headerValue;
}

// Walk a multi-pair Cookie header string and substitute the auth cookie + csrf cookie.
function substituteCookieHeader(headerValue, authProfile, usedVars) {
  const src = authProfile.auth_value_source || '';
  let authCookieName = null;
  if (src.startsWith('cookie:')) {
    authCookieName = src.slice('cookie:'.length);
  }

  const csrfSrc = authProfile.csrf_token_source || '';
  let csrfCookieName = null;
  if (csrfSrc.startsWith('cookie:')) {
    csrfCookieName = csrfSrc.slice('cookie:'.length);
  }

  const parts = headerValue.split(';').map(p => p.trim()).filter(Boolean);
  const rebuilt = parts.map(pair => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair;
    const name = pair.slice(0, eq);
    if (authCookieName && name === authCookieName) {
      usedVars.add('session_cookie');
      return `${name}={{session_cookie}}`;
    }
    if (csrfCookieName && name === csrfCookieName) {
      usedVars.add('csrf_token');
      return `${name}={{csrf_token}}`;
    }
    // Heuristic fallback — common csrf cookie names
    if (/^(_csrf|csrf_token|xsrf-token|x-csrf-token)$/i.test(name)) {
      usedVars.add('csrf_token');
      return `${name}={{csrf_token}}`;
    }
    return pair;
  });
  return rebuilt.join('; ');
}

function buildEnvironmentFile(session, authProfile, usedVars) {
  const values = [];
  if (usedVars.has('auth_token')) {
    values.push({ key: 'auth_token', value: 'REPLACE_ME', type: 'secret', enabled: true });
  }
  if (usedVars.has('session_cookie')) {
    values.push({ key: 'session_cookie', value: 'REPLACE_ME', type: 'secret', enabled: true });
  }
  if (usedVars.has('csrf_token')) {
    values.push({ key: 'csrf_token', value: 'REPLACE_ME', type: 'secret', enabled: true });
  }
  if (usedVars.has('api_key')) {
    values.push({ key: 'api_key', value: 'REPLACE_ME', type: 'secret', enabled: true });
  }
  // OAuth-specific helper vars
  if (usedVars.has('refresh_url')) {
    const refreshUrl = (authProfile.refresh_endpoint_candidates && authProfile.refresh_endpoint_candidates[0]) || 'REPLACE_ME';
    values.push({ key: 'refresh_url', value: refreshUrl, type: 'default', enabled: true });
  }
  if (usedVars.has('refresh_token')) {
    values.push({ key: 'refresh_token', value: 'REPLACE_ME', type: 'secret', enabled: true });
  }
  if (usedVars.has('token_expires_at')) {
    values.push({ key: 'token_expires_at', value: '', type: 'default', enabled: true });
  }

  // base_url — auto-detected from session.startUrl host
  let baseUrl = '';
  try {
    const u = new URL(session.startUrl);
    baseUrl = `${u.protocol}//${u.host}`;
  } catch {
    baseUrl = '';
  }
  values.push({ key: 'base_url', value: baseUrl, type: 'default', enabled: true });

  const id = generateUuid();
  const envName = `AgentScribe — ${session.name || session.startUrl}`;
  const env = {
    id,
    name: envName,
    values,
    _postman_variable_scope: 'environment',
    _postman_exported_at: new Date().toISOString(),
    _postman_exported_using: 'AgentScribe/1.0.13'
  };

  return {
    content: JSON.stringify(env, null, 2),
    filename: `agentscribe-postman-env-${id}.json`,
    mimeType: 'application/json'
  };
}

function buildOAuthPrerequestScript(refreshUrl) {
  return [
    "// Refresh access token if expired (auto-injected by AgentScribe)",
    "const expiry = pm.environment.get('token_expires_at');",
    "if (!expiry || Date.now() > parseInt(expiry, 10)) {",
    "  pm.sendRequest({",
    "    url: pm.environment.get('refresh_url'),",
    "    method: 'POST',",
    "    body: { mode: 'urlencoded', urlencoded: [",
    "      { key: 'grant_type', value: 'refresh_token' },",
    "      { key: 'refresh_token', value: pm.environment.get('refresh_token') }",
    "    ]}",
    "  }, (err, res) => {",
    "    if (!err) {",
    "      const data = res.json();",
    "      pm.environment.set('auth_token', data.access_token);",
    "      pm.environment.set('token_expires_at', Date.now() + data.expires_in * 1000);",
    "    }",
    "  });",
    "}"
  ];
}

function generateUuid() {
  // RFC4122 v4-style — no crypto dependency required in extension context
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      s += '-';
    } else if (i === 14) {
      s += '4';
    } else if (i === 19) {
      s += hex[(Math.random() * 4) | 0 | 8];
    } else {
      s += hex[(Math.random() * 16) | 0];
    }
  }
  return s;
}

function deduplicateEndpoints(networkEvents) {
  const seen = new Map();
  const results = [];
  for (const evt of networkEvents) {
    if (evt.isAnalytics) continue;
    const key = `${evt.method}|${evt.url}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      results.push(evt);
    }
  }
  return results;
}

function groupByDomain(endpoints) {
  const groups = new Map();
  for (const req of endpoints) {
    let domain;
    try { domain = new URL(req.url).hostname; }
    catch { domain = 'unknown'; }
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(req);
  }
  return Array.from(groups.entries()).map(([domain, requests]) => ({ domain, requests }));
}

function parsePostmanUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return {
      raw: rawUrl,
      protocol: u.protocol.replace(':', ''),
      host: u.hostname.split('.'),
      port: u.port || undefined,
      path: u.pathname.split('/').filter(Boolean),
      query: Array.from(u.searchParams.entries()).map(([key, value]) => ({ key, value }))
    };
  } catch {
    return { raw: rawUrl };
  }
}

function safePath(url) {
  try { return new URL(url).pathname; }
  catch { return url; }
}

function statusText(code) {
  const map = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Server Error' };
  return map[code] || String(code);
}
