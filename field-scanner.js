const SENSITIVE_INDICATORS = ['password', 'credit', 'cc-', 'cvv', 'cvc', 'ssn', 'social', 'secret', 'token'];

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

function scanFields(root, tabId, url) {
  const results = [];

  function scanRoot(r) {
    const selectors = 'input, textarea, select, [contenteditable="true"]';
    r.querySelectorAll(selectors).forEach(el => {
      if (el.type === 'hidden') return;
      results.push({
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
        flag: 'INJECTABLE_POINT'
      });
    });

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
}
