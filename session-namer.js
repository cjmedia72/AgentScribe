// Infers a human-readable session name from the captured events.
// Pattern: "{hostname} — {action} · {short_date}"
// Falls back gracefully if heuristics don't match.

const SUBMIT_WORDS = /\b(submit|confirm|save|create|update|proceed|continue|checkout|add to cart|buy|purchase|order|send|publish|delete|remove|apply)\b/i;
const SEARCH_WORDS = /\b(search|find|query|lookup|filter)\b/i;
const SEARCH_FIELD_RE = /\b(search|q|query|keyword|term|find|filter)\b/i;
const LOGIN_RE = /\b(login|log-in|signin|sign-in|authenticate|auth\/token|oauth)\b/i;
const CART_RE = /\b(cart|basket|checkout)\b/i;
const SUBMIT_API_RE = /\b(submit|create|update|save|publish|order|purchase)\b/i;

export function inferSessionName(session) {
  const host = getHostname(session.startUrl);
  const action = inferPrimaryAction(session);
  const date = shortDate(session.startTime);

  if (action) return `${host} — ${action} · ${date}`;
  return `${host} · ${date}`;
}

export function inferStartName(startUrl) {
  const host = getHostname(startUrl);
  return `${host} · recording…`;
}

function inferPrimaryAction(session) {
  const events = Array.isArray(session.events) ? session.events : [];
  const network = Array.isArray(session.networkEvents) ? session.networkEvents : [];

  // 1. Login flow
  const hasPasswordInput = events.some(e =>
    e.type === 'input' && e.element?.type === 'password'
  );
  const hasLoginEndpoint = network.some(n =>
    LOGIN_RE.test(n.url || '')
  );
  if (hasPasswordInput || hasLoginEndpoint) return 'Login';

  // 2. Search action — pull the actual search term if visible
  const searchInput = events.find(e =>
    (e.type === 'input' || e.type === 'change') &&
    e.value && e.value !== '[REDACTED]' &&
    isSearchField(e.element)
  );
  if (searchInput) {
    const term = String(searchInput.value).trim().slice(0, 40);
    if (term) return `Search "${term}"`;
  }

  // 3. Cart / checkout flow
  const cartHit = network.find(n => CART_RE.test(n.url || ''));
  if (cartHit) {
    if (/checkout/i.test(cartHit.url)) return 'Checkout';
    return 'Add to cart';
  }

  // 4. Submit-style button click — use button text
  const submitClick = events.find(e =>
    e.type === 'click' && (
      SUBMIT_WORDS.test(e.element?.text || '') ||
      SUBMIT_WORDS.test(e.element?.ariaLabel || '') ||
      SUBMIT_WORDS.test(e.element?.name || '')
    )
  );
  if (submitClick) {
    const label = (submitClick.element?.text || submitClick.element?.ariaLabel || 'Submit').trim();
    return cleanLabel(label, 40);
  }

  // 5. POST/PUT/DELETE API hit — name by endpoint
  const writeApi = network.find(n =>
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(n.method) &&
    !isAnalytics(n.url)
  );
  if (writeApi) {
    const path = pathFor(writeApi.url);
    if (SUBMIT_API_RE.test(path)) return `${writeApi.method} ${shortPath(path)}`;
    return `${writeApi.method} ${shortPath(path)}`;
  }

  // 6. Multi-page browsing — use the most-visited path
  const navs = events.filter(e => e.type === 'navigation');
  if (navs.length >= 2) {
    const paths = new Map();
    navs.forEach(n => {
      const p = pathFor(n.url);
      if (p && p !== '/') paths.set(p, (paths.get(p) || 0) + 1);
    });
    if (paths.size > 0) {
      const sorted = [...paths.entries()].sort((a, b) => b[1] - a[1]);
      const [topPath] = sorted[0];
      return `Browse ${shortPath(topPath)}`;
    }
    return `Browse ${navs.length} pages`;
  }

  // 7. Form fill — multiple inputs but no submit
  const inputs = events.filter(e => e.type === 'input' || e.type === 'change');
  if (inputs.length >= 3) {
    return `Form fill (${inputs.length} fields)`;
  }

  // 8. Just clicks
  const clicks = events.filter(e => e.type === 'click').length;
  if (clicks > 0) return `${clicks} click${clicks === 1 ? '' : 's'}`;

  return null;
}

function isSearchField(el) {
  if (!el) return false;
  const sig = [el.name, el.id, el.placeholder, el.ariaLabel, el.type]
    .filter(Boolean).join(' ').toLowerCase();
  return SEARCH_FIELD_RE.test(sig) || el.type === 'search';
}

function getHostname(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') || u.host || 'page';
  } catch {
    return 'page';
  }
}

function pathFor(url) {
  try { return new URL(url).pathname; }
  catch { return url || ''; }
}

function shortPath(path) {
  if (!path) return '/';
  if (path.length <= 40) return path;
  return path.slice(0, 37) + '…';
}

function cleanLabel(s, max) {
  return String(s).replace(/\s+/g, ' ').trim().slice(0, max);
}

function isAnalytics(url) {
  if (!url) return false;
  return /(analytics|metrics|telemetry|beacon|segment\.io|mixpanel|hotjar|fullstory|quantummetric)/i.test(url);
}

function shortDate(ts) {
  const d = new Date(ts);
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  return d.toLocaleString(undefined, opts);
}
