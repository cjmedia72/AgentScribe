export function exportSOP(session) {
  const lines = [];
  const name = session.name || 'Untitled Session';
  const date = new Date(session.startTime).toLocaleString();
  const actionEvents = session.events.filter(e =>
    ['click', 'input', 'navigation', 'scroll', 'paste'].includes(e.type)
  );

  lines.push(`# Workflow SOP — ${name}`);
  lines.push(`**Recorded:** ${date} | **URL:** ${session.startUrl} | **Steps:** ${actionEvents.length} | **API Calls:** ${session.networkEvents.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ---- v1.0.13: Authentication Flow section ----
  try {
    const authLines = buildAuthFlowSection(session);
    if (authLines.length) {
      authLines.forEach(l => lines.push(l));
      lines.push('---');
      lines.push('');
    }
  } catch (_) { /* tolerate missing/malformed authProfile */ }

  // ---- v1.0.13: Hidden State Captured section ----
  try {
    const stateLines = buildHiddenStateSection(session);
    if (stateLines.length) {
      stateLines.forEach(l => lines.push(l));
      lines.push('---');
      lines.push('');
    }
  } catch (_) { /* tolerate missing storageSnapshots/cookieSnapshots */ }

  // ---- v1.0.13: Replay Caveats section ----
  try {
    const caveatLines = buildReplayCaveatsSection(session, actionEvents);
    if (caveatLines.length) {
      caveatLines.forEach(l => lines.push(l));
      lines.push('---');
      lines.push('');
    }
  } catch (_) { /* tolerate missing fields */ }

  actionEvents.forEach((event, i) => {
    const step = i + 1;
    const elapsed = formatTime(event.timestamp - session.startTime);

    lines.push(`## Step ${step} — ${describeAction(event)} (${elapsed})`);
    lines.push('');

    if (event.type === 'navigation') {
      lines.push(`**Action:** Page loaded`);
      lines.push(`**URL:** ${event.url}`);
    } else if (event.type === 'click') {
      const desc = elementDescription(event.element);
      lines.push(`**Action:** Click on ${desc}`);
      if (event.element?.cssSelector) lines.push(`**Selector:** \`${escapeCode(event.element.cssSelector)}\``);
      if (event.element?.xpath) lines.push(`**XPath:** \`${escapeCode(event.element.xpath)}\``);
      if (event.triggeredRequests?.length) {
        event.triggeredRequests.forEach(req => {
          lines.push(`**API Triggered:** \`${escapeCode(req.method + ' ' + safePath(req.url))}\` → Status ${req.responseStatus}`);
          if (req.postData) {
            const payload = typeof req.postData === 'string'
              ? req.postData
              : JSON.stringify(req.postData);
            lines.push(`**Payload:** \`${escapeCode(truncate(payload, 200))}\``);
          }
        });
      }
    } else if (event.type === 'input' || event.type === 'paste') {
      const fieldName = event.element?.name || event.element?.id || event.element?.placeholder || 'field';
      lines.push(`**Action:** ${event.type === 'paste' ? 'Paste' : 'Type'} into \`${escapeCode(fieldName)}\``);
      if (event.element?.cssSelector) lines.push(`**Selector:** \`${escapeCode(event.element.cssSelector)}\``);
      if (event.value === '[REDACTED]') {
        lines.push(`**Value:** [REDACTED — sensitive field]`);
      } else if (event.value) {
        lines.push(`**Value:** \`${escapeCode(truncate(event.value, 100))}\``);
      }
      if (event.flag === 'INJECTABLE_POINT') {
        const param = event.element?.name || event.element?.id || '?';
        const action = event.element?.formAction || 'unknown';
        lines.push(`**Injectable point:** YES — POST param: \`${escapeCode(param)}\` → \`${escapeCode(action)}\``);
      }
    } else if (event.type === 'scroll') {
      lines.push(`**Action:** Scroll page`);
      lines.push(`**Position:** x:${event.scrollX || 0}, y:${event.scrollY || 0}`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  });

  if (session.injectableFields?.length) {
    lines.push('## Injectable Fields Summary');
    lines.push('');
    lines.push('| Field | Type | POST Param | Form Action | Sensitive |');
    lines.push('|---|---|---|---|---|');
    session.injectableFields.forEach(f => {
      const fieldName = escapeCode(f.name || f.id_attr || f.tag || '-').replace(/\|/g, '\\|');
      const param = escapeCode(f.postParamName || '-').replace(/\|/g, '\\|');
      const action = escapeCode(f.formAction || '-').replace(/\|/g, '\\|');
      lines.push(`| \`${fieldName}\` | ${f.type || '-'} | \`${param}\` | \`${action}\` | ${f.isSensitive ? 'YES' : 'no'} |`);
    });
    lines.push('');
  }

  if (session.networkEvents?.length) {
    const unique = new Set(session.networkEvents.map(n => `${n.method} ${safePath(n.url)}`));
    lines.push('## API Endpoints Discovered');
    lines.push('');
    unique.forEach(ep => lines.push(`- \`${escapeCode(ep)}\``));
    lines.push('');
  }

  return {
    content: lines.join('\n'),
    filename: `agentscribe-sop-${Date.now()}.md`,
    mimeType: 'text/markdown'
  };
}

function describeAction(event) {
  if (event.type === 'navigation') return `Navigate to ${escapeMd(safePath(event.url))}`;
  if (event.type === 'click') return `Click ${elementDescription(event.element)}`;
  if (event.type === 'input') return `Input into ${escapeMd(event.element?.name || event.element?.id || 'field')}`;
  if (event.type === 'paste') return `Paste into ${escapeMd(event.element?.name || event.element?.id || 'field')}`;
  if (event.type === 'scroll') return `Scroll page`;
  return event.type;
}

function elementDescription(el) {
  if (!el) return 'element';
  if (el.text) return `\`${escapeCode(truncate(el.text, 40))}\``;
  if (el.ariaLabel) return `\`${escapeCode(el.ariaLabel)}\``;
  if (el.id) return `\`#${escapeCode(el.id)}\``;
  if (el.name) return `\`[name="${escapeCode(el.name)}"]\``;
  return `\`${escapeCode(el.tag || 'element')}\``;
}

// Escape only the actually-dangerous chars (backslash, backtick, asterisk,
// brackets, pipe). Underscore/paren/hash etc render fine inline.
function escapeMd(s) {
  if (s == null) return '';
  return String(s).replace(/([\\`*\[\]|])/g, '\\$1');
}

function escapeCode(s) {
  if (s == null) return '';
  // Inside backtick spans, the dangerous char is the backtick itself.
  // Replace ` with a Unicode lookalike (U+02CB) to avoid breaking the span.
  return String(s).replace(/`/g, 'ˋ');
}

function safePath(url) {
  try { return new URL(url).pathname; }
  catch { return url; }
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// v1.0.13 — Authentication Flow / Hidden State / Replay Caveats builders
// All builders are defensive: any missing/malformed field collapses gracefully
// and the section is either skipped or rendered with a fallback line.
// ---------------------------------------------------------------------------

function buildAuthFlowSection(session) {
  const out = [];
  out.push('## Authentication Flow');
  out.push('');

  const profile = session && session.authProfile;
  const scheme = profile && profile.auth_scheme;

  if (!profile || !scheme || scheme === 'none') {
    out.push('No authentication detected. This appears to be a public workflow.');
    out.push('');
    return out;
  }

  const storageLocation = profile.auth_value_source || 'an unknown location';
  const expiresAt = profile.expires_at;
  const refreshEndpoint = profile.refresh_endpoint_hint || profile.refresh_endpoint;

  let expiryClause;
  if (typeof expiresAt === 'number' && isFinite(expiresAt)) {
    const now = Math.floor(Date.now() / 1000);
    const epochSec = expiresAt > 1e12 ? Math.floor(expiresAt / 1000) : expiresAt;
    const delta = Math.max(0, epochSec - now);
    expiryClause = `expires in approximately **${delta}** seconds`;
  } else if (profile.refresh_interval_seconds) {
    expiryClause = `expires every **${profile.refresh_interval_seconds}** seconds`;
  } else {
    expiryClause = 'does not appear to expire on a fixed schedule';
  }

  const refreshClause = refreshEndpoint
    ? ` and is refreshed by calling **\`${escapeCode(refreshEndpoint)}\`**`
    : '';

  out.push(`Your session uses **${escapeMd(scheme)}** authentication. The token lives in **\`${escapeCode(storageLocation)}\`**.`);
  out.push(`It ${expiryClause}${refreshClause}.`);
  out.push('');

  // JWT details
  const jwt = profile.jwt_decoded;
  if (jwt && typeof jwt === 'object') {
    const iss = jwt.iss || jwt.payload?.iss;
    const aud = jwt.aud || jwt.payload?.aud;
    const sub = jwt.sub || jwt.payload?.sub;
    const exp = jwt.exp || jwt.payload?.exp;
    if (iss || aud || sub || exp) {
      const issLabel = iss ? `\`${escapeCode(String(iss))}\`` : '(unknown issuer)';
      const audLabel = aud ? `\`${escapeCode(String(Array.isArray(aud) ? aud.join(',') : aud))}\`` : '(unknown audience)';
      out.push(`The JWT was issued by ${issLabel} to audience ${audLabel} and contains the following claims:`);
      if (sub) out.push(`- subject: \`${escapeCode(String(sub))}\``);
      if (exp) {
        const expSec = Number(exp) > 1e12 ? Math.floor(Number(exp) / 1000) : Number(exp);
        let iso = '';
        try { iso = new Date(expSec * 1000).toISOString(); } catch (_) { iso = String(exp); }
        out.push(`- exp: \`${escapeCode(String(exp))}\` (${escapeMd(iso)})`);
      }
      if (iss) out.push(`- iss: \`${escapeCode(String(iss))}\``);
      if (aud) out.push(`- aud: \`${escapeCode(String(Array.isArray(aud) ? aud.join(',') : aud))}\``);
      out.push('');
    }
  }

  // CSRF details
  if (profile.csrf_token_source) {
    out.push(`This session also uses CSRF protection via **\`${escapeCode(profile.csrf_token_source)}\`**. You must fetch a fresh CSRF token before mutation requests.`);
    out.push('');
  }

  return out;
}

function buildHiddenStateSection(session) {
  const out = [];
  if (!session) return out;

  // Collect cookies from latest cookieSnapshot
  const cookieSnaps = Array.isArray(session.cookieSnapshots) ? session.cookieSnapshots : [];
  const latestCookieSnap = cookieSnaps.length ? cookieSnaps[cookieSnaps.length - 1] : null;
  const cookies = (latestCookieSnap && Array.isArray(latestCookieSnap.cookies)) ? latestCookieSnap.cookies : [];

  // Collect storage from latest storageSnapshot
  const storageSnaps = Array.isArray(session.storageSnapshots) ? session.storageSnapshots : [];
  const latestStorageSnap = storageSnaps.length ? storageSnaps[storageSnaps.length - 1] : null;
  const localStorageObj = (latestStorageSnap && latestStorageSnap.localStorage) || {};
  const sessionStorageObj = (latestStorageSnap && latestStorageSnap.sessionStorage) || {};
  const indexedDB = (latestStorageSnap && Array.isArray(latestStorageSnap.indexedDB)) ? latestStorageSnap.indexedDB : [];

  const hasAny = cookies.length || Object.keys(localStorageObj).length || Object.keys(sessionStorageObj).length || indexedDB.length;
  if (!hasAny) return out;

  out.push('## Hidden State Captured');
  out.push('');
  out.push('The following client-side state was active during this recording:');
  out.push('');

  // Cookies
  if (cookies.length) {
    out.push(`**Cookies** (${cookies.length} total):`);
    cookies.slice(0, 50).forEach(c => {
      const parts = [];
      if (c.domain) parts.push(`domain: ${escapeMd(c.domain)}`);
      if (c.expirationDate) {
        let iso = '';
        try { iso = new Date(c.expirationDate * 1000).toISOString().slice(0, 10); } catch (_) { iso = String(c.expirationDate); }
        parts.push(`expires: ${escapeMd(iso)}`);
      }
      if (c.httpOnly) parts.push('httpOnly');
      if (c.secure) parts.push('secure');
      const meta = parts.length ? ` (${parts.join(', ')})` : '';
      out.push(`- \`${escapeCode(c.name || '(unnamed)')}\`${meta}`);
    });
    if (cookies.length > 50) out.push(`- ...and ${cookies.length - 50} more`);
    out.push('');
  }

  // localStorage
  const lsKeys = Object.keys(localStorageObj);
  if (lsKeys.length) {
    out.push(`**localStorage** (${lsKeys.length} keys):`);
    lsKeys.slice(0, 50).forEach(k => out.push(`- \`${escapeCode(k)}\``));
    if (lsKeys.length > 50) out.push(`- ...and ${lsKeys.length - 50} more`);
    out.push('');
  }

  // sessionStorage
  const ssKeys = Object.keys(sessionStorageObj);
  if (ssKeys.length) {
    out.push(`**sessionStorage** (${ssKeys.length} keys):`);
    ssKeys.slice(0, 50).forEach(k => out.push(`- \`${escapeCode(k)}\``));
    if (ssKeys.length > 50) out.push(`- ...and ${ssKeys.length - 50} more`);
    out.push('');
  }

  // IndexedDB — group by db name, count distinct stores
  if (indexedDB.length) {
    out.push('**IndexedDB databases**:');
    const byDb = new Map();
    indexedDB.forEach(entry => {
      if (!entry || !entry.db) return;
      if (!byDb.has(entry.db)) byDb.set(entry.db, new Set());
      if (entry.store) byDb.get(entry.db).add(entry.store);
    });
    byDb.forEach((stores, db) => {
      out.push(`- \`${escapeCode(db)}\` — ${stores.size} object store${stores.size === 1 ? '' : 's'}`);
    });
    out.push('');
  }

  return out;
}

function buildReplayCaveatsSection(session, actionEvents) {
  const out = [];
  if (!session) return out;

  const caveats = [];

  // OTP detection — scan events for runtime_input_required or OTP-flagged elements
  const events = Array.isArray(actionEvents) ? actionEvents : [];
  let otpStepIdx = -1;
  let otpSelector = '';
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const el = ev && ev.element;
    const isOtp = (ev && ev.runtime_input_required) ||
                  (el && (el.runtime_input_required ||
                          el.autocomplete === 'one-time-code' ||
                          (typeof el.name === 'string' && /otp|2fa|one[-_]?time/i.test(el.name))));
    if (isOtp) {
      otpStepIdx = i + 1;
      otpSelector = (el && (el.cssSelector || el.id || el.name)) || '';
      break;
    }
  }
  if (otpStepIdx > 0) {
    const selLabel = otpSelector ? ` (\`${escapeCode(otpSelector)}\`)` : '';
    caveats.push(`- **2FA / OTP required**: Step ${otpStepIdx} uses a one-time code field${selLabel}. The recorded value will be expired — your replay script must accept fresh OTP input.`);
  }

  // Anti-bot challenge layer
  if (session.challengeLayer) {
    caveats.push(`- **Anti-bot layer**: This site is protected by \`${escapeCode(String(session.challengeLayer))}\`. Bare automation will fail at the challenge gate. Use a stealth browser or recorded session injection.`);
  }

  // CSRF re-fetch
  const csrfSource = session.authProfile && session.authProfile.csrf_token_source;
  if (csrfSource) {
    caveats.push(`- **CSRF token re-fetch**: This site requires a fresh CSRF token on each session. Capture it from \`${escapeCode(csrfSource)}\` before sending mutating requests.`);
  }

  // Token expiry
  const profile = session.authProfile || {};
  const jwt = profile.jwt_decoded;
  const exp = (jwt && (jwt.exp || (jwt.payload && jwt.payload.exp))) || null;
  if (exp) {
    const expSec = Number(exp) > 1e12 ? Math.floor(Number(exp) / 1000) : Number(exp);
    let iso = '';
    try { iso = new Date(expSec * 1000).toISOString(); } catch (_) { iso = String(exp); }
    const refresh = profile.refresh_endpoint_hint || profile.refresh_endpoint;
    const refreshClause = refresh ? ` via \`POST ${escapeCode(refresh)}\`` : '';
    caveats.push(`- **Token expiry**: The captured JWT expires at ${escapeMd(iso)}. If your replay runs after that, you must refresh first${refreshClause}.`);
  }

  if (!caveats.length) return out;

  out.push('## Replay Caveats');
  out.push('');
  out.push('When replaying this workflow, be aware:');
  out.push('');
  caveats.forEach(c => out.push(c));
  out.push('');

  return out;
}

