const SENSITIVE_INDICATORS = ['password', 'credit', 'cc-', 'cvv', 'cvc', 'ssn', 'social', 'secret', 'token'];

// OTP / 2FA hint regex — matched against name/id/aria-label/placeholder
const OTP_HINT_RE = /(?:^|[^a-z])(otp|2fa|verify|verification|code)(?:[^a-z]|$)/i;

// CSRF hidden-input name regex
const CSRF_NAME_RE = /_csrf|authenticity_token|csrf[_-]?token|csrfmiddlewaretoken|__RequestVerificationToken/i;

function isSensitiveField(el) {
  const indicators = [el.type, el.name, el.id, el.autocomplete, el.placeholder]
    .filter(Boolean)
    .map(v => v.toLowerCase());
  return SENSITIVE_INDICATORS.some(s => indicators.some(i => i.includes(s)));
}

function inferPurpose(el) {
  const hints = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('data-purpose')]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const purposes = {
    'search': 'Search input',
    'email': 'Email address',
    'amount|price|total': 'Monetary amount',
    'seller|merchant': 'Seller identifier',
    'asin|sku|item': 'Product identifier',
    'quantity|qty': 'Quantity',
    'date|from|to|start|end': 'Date range',
    'filter|sort': 'Filter/sort control',
    'submit|confirm|proceed': 'Form submission trigger',
    'name|first|last': 'Name field',
    'phone|tel|mobile': 'Phone number',
    'address|street|city|zip|postal': 'Address field',
    'comment|message|note': 'Text content',
    'url|link|website': 'URL input',
    'file|upload|attach': 'File upload',
    'user|login|username': 'Username/login'
  };

  for (const [pattern, label] of Object.entries(purposes)) {
    if (pattern.split('|').some(p => hints.includes(p))) return label;
  }
  return 'Unknown — review manually';
}

function getXPath(el) {
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts = [];
  let current = el;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let idx = 1;
    let sib = current.previousSibling;
    while (sib) {
      if (sib.nodeType === Node.ELEMENT_NODE && sib.tagName === current.tagName) idx++;
      sib = sib.previousSibling;
    }
    parts.unshift(`${current.tagName.toLowerCase()}[${idx}]`);
    current = current.parentNode;
    if (current instanceof ShadowRoot) current = current.host;
  }
  return '/' + parts.join('/');
}

function getCSSSelector(el) {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts = [];
  let current = el;
  while (current && current.tagName) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const classes = Array.from(current.classList).slice(0, 2).map(c => CSS.escape(c)).join('.');
      if (classes) selector += `.${classes}`;
    }
    parts.unshift(selector);
    current = current.parentElement;
    if (parts.length > 4) break;
  }
  return parts.join(' > ');
}

// ---------- Wave 3 detectors ----------

/**
 * Returns true if `el` looks like an OTP / 2FA input.
 * Criteria: autocomplete=one-time-code  OR
 *           name/id/aria-label/placeholder matches /otp|2fa|verify|verification|code/i
 *           AND type is text|number AND maxlength in [4,8].
 */
function isOTPField(el) {
  try {
    if (!el || !el.tagName || el.tagName.toLowerCase() !== 'input') return false;
    const ac = (el.getAttribute && el.getAttribute('autocomplete')) || el.autocomplete || '';
    if (typeof ac === 'string' && ac.toLowerCase() === 'one-time-code') return true;

    const type = (el.type || '').toLowerCase();
    if (type !== 'text' && type !== 'number' && type !== 'tel') return false;

    // maxlength may live on the property or attribute
    let maxlen = null;
    if (typeof el.maxLength === 'number' && el.maxLength > 0) maxlen = el.maxLength;
    if (maxlen === null && el.getAttribute) {
      const a = el.getAttribute('maxlength');
      if (a != null && a !== '') {
        const n = parseInt(a, 10);
        if (!isNaN(n) && n > 0) maxlen = n;
      }
    }
    if (maxlen === null || maxlen < 4 || maxlen > 8) return false;

    const hints = [
      el.name,
      el.id,
      el.getAttribute && el.getAttribute('aria-label'),
      el.placeholder,
    ]
      .filter(Boolean)
      .join(' ');
    return OTP_HINT_RE.test(hints);
  } catch {
    return false;
  }
}

/**
 * Returns true if `el` is a hidden input whose name matches a known CSRF token pattern.
 */
function isCSRFHiddenInput(el) {
  try {
    if (!el || !el.tagName || el.tagName.toLowerCase() !== 'input') return false;
    const type = (el.type || '').toLowerCase();
    if (type !== 'hidden') return false;
    const name = el.name || (el.getAttribute && el.getAttribute('name')) || '';
    if (!name) return false;
    return CSRF_NAME_RE.test(name);
  } catch {
    return false;
  }
}

/**
 * Detects the presence of an anti-bot challenge layer on the document.
 * Returns one of 'cloudflare' | 'perimeterx' | 'akamai' | 'hcaptcha' | 'recaptcha' | null.
 * First match wins (checked in the order above).
 *
 * Pure-DOM (no chrome.* APIs). Each provider check is independently try/caught
 * so one broken DOM access cannot break the others.
 */
function detectChallengeLayer(doc) {
  if (!doc) return null;

  // Helper to read cookies safely as a single string
  let cookieStr = '';
  try {
    cookieStr = (doc.cookie || '') + '';
  } catch {
    cookieStr = '';
  }

  // 1. Cloudflare Turnstile / clearance
  try {
    if (/(?:^|;\s*)cf_clearance=/.test(cookieStr)) return 'cloudflare';
    if (doc.querySelector && doc.querySelector('.cf-turnstile, [data-sitekey][class*="cf-turnstile"], cf-turnstile')) return 'cloudflare';
    if (doc.querySelectorAll) {
      const iframes = doc.querySelectorAll('iframe');
      for (const f of iframes) {
        const src = (f.getAttribute && f.getAttribute('src')) || f.src || '';
        if (src && src.indexOf('challenges.cloudflare.com') !== -1) return 'cloudflare';
      }
    }
  } catch { /* skip */ }

  // 2. PerimeterX
  try {
    if (/(?:^|;\s*)_pxhd=/.test(cookieStr)) return 'perimeterx';
    if (doc.querySelectorAll) {
      const scripts = doc.querySelectorAll('script[src]');
      for (const s of scripts) {
        const src = (s.getAttribute && s.getAttribute('src')) || s.src || '';
        if (src && (src.indexOf('perimeterx.net') !== -1 || src.indexOf('px-cdn') !== -1)) return 'perimeterx';
      }
    }
  } catch { /* skip */ }

  // 3. Akamai Bot Manager
  try {
    if (/(?:^|;\s*)_abck=/.test(cookieStr)) return 'akamai';
    if (doc.querySelectorAll) {
      const scripts = doc.querySelectorAll('script[src]');
      for (const s of scripts) {
        const src = (s.getAttribute && s.getAttribute('src')) || s.src || '';
        if (src && src.indexOf('akamaihd.net/akam-') !== -1) return 'akamai';
      }
    }
  } catch { /* skip */ }

  // 4. hCaptcha
  try {
    if (doc.querySelectorAll) {
      const iframes = doc.querySelectorAll('iframe');
      for (const f of iframes) {
        const src = (f.getAttribute && f.getAttribute('src')) || f.src || '';
        if (src && src.indexOf('hcaptcha.com') !== -1) return 'hcaptcha';
      }
    }
  } catch { /* skip */ }

  // 5. reCAPTCHA
  try {
    if (doc.querySelectorAll) {
      const iframes = doc.querySelectorAll('iframe');
      for (const f of iframes) {
        const src = (f.getAttribute && f.getAttribute('src')) || f.src || '';
        if (src && src.indexOf('google.com/recaptcha') !== -1) return 'recaptcha';
      }
    }
  } catch { /* skip */ }

  return null;
}

function scanFields(root, tabId, url) {
  const results = [];

  function scanRoot(r) {
    // Scan visible/editable controls (existing behavior).
    const selectors = 'input, textarea, select, [contenteditable="true"]';
    r.querySelectorAll(selectors).forEach(el => {
      if (el.type === 'hidden') return;

      // OTP detection (wrapped so any failure cannot break the scan)
      let otpDetected = false;
      try { otpDetected = isOTPField(el); } catch { otpDetected = false; }

      const entry = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        tabId,
        url,
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        id_attr: el.id || null,
        name: el.name || null,
        placeholder: el.placeholder || null,
        autocomplete: el.autocomplete || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        xpath: getXPath(el),
        cssSelector: getCSSSelector(el),
        formAction: el.form?.action || null,
        formMethod: el.form?.method?.toUpperCase() || null,
        postParamName: el.name || el.id || null,
        purposeInferred: inferPurpose(el),
        isInShadowDOM: el.getRootNode() instanceof ShadowRoot,
        shadowHostSelector: el.getRootNode() instanceof ShadowRoot
          ? getCSSSelector(el.getRootNode().host)
          : null,
        isSensitive: isSensitiveField(el),
        field_kind: otpDetected ? 'otp' : null,
        runtime_input_required: otpDetected ? true : false,
        flag: 'INJECTABLE_POINT'
      };
      results.push(entry);
    });

    // Wave 3 addition: also surface hidden CSRF inputs (previously skipped).
    // Existing schema is preserved for the standard pass above; CSRF entries
    // are tagged with field_kind='csrf' and carry the literal token value so
    // the auth-detector can correlate it with request headers.
    try {
      r.querySelectorAll('input[type="hidden"]').forEach(el => {
        let isCsrf = false;
        try { isCsrf = isCSRFHiddenInput(el); } catch { isCsrf = false; }
        if (!isCsrf) return;
        results.push({
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          tabId,
          url,
          tag: el.tagName.toLowerCase(),
          type: 'hidden',
          id_attr: el.id || null,
          name: el.name || null,
          placeholder: null,
          autocomplete: null,
          ariaLabel: el.getAttribute('aria-label') || null,
          xpath: getXPath(el),
          cssSelector: getCSSSelector(el),
          formAction: el.form?.action || null,
          formMethod: el.form?.method?.toUpperCase() || null,
          postParamName: el.name || el.id || null,
          purposeInferred: 'CSRF token',
          isInShadowDOM: el.getRootNode() instanceof ShadowRoot,
          shadowHostSelector: el.getRootNode() instanceof ShadowRoot
            ? getCSSSelector(el.getRootNode().host)
            : null,
          isSensitive: true,
          field_kind: 'csrf',
          csrf_token_source: 'hidden_input',
          value: el.value || null,
          runtime_input_required: false,
          flag: 'INJECTABLE_POINT'
        });
      });
    } catch { /* skip CSRF pass on error */ }

    r.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) scanRoot(el.shadowRoot);
    });
  }

  scanRoot(root || document);
  return results;
}

if (typeof window !== 'undefined') {
  window.__agentscribe = window.__agentscribe || {};
  window.__agentscribe.scanFields = scanFields;
  window.__agentscribe.getXPath = getXPath;
  window.__agentscribe.getCSSSelector = getCSSSelector;
  window.__agentscribe.isSensitiveField = isSensitiveField;
  window.__agentscribe.isOTPField = isOTPField;
  window.__agentscribe.isCSRFHiddenInput = isCSRFHiddenInput;
  window.__agentscribe.detectChallengeLayer = detectChallengeLayer;
}

// CommonJS export for Node test runners. Gated so the browser load path
// (chrome.scripting.executeScript injection) is untouched.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    scanFields,
    getXPath,
    getCSSSelector,
    isSensitiveField,
    inferPurpose,
    isOTPField,
    isCSRFHiddenInput,
    detectChallengeLayer,
  };
}
