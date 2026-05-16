(() => {
  if (window.__agentscribe_content_loaded) return;
  window.__agentscribe_content_loaded = true;

  // Top-frame check — only the top window paints the overlay UI.
  // Iframes still capture events (per all_frames:true) but don't show overlays.
  const isTopFrame = (() => {
    try { return window.top === window; } catch { return false; }
  })();

  let capturing = false;
  let eventCount = 0;
  let settings = null;
  let fieldMap = new Map();
  let scrollTimeout = null;
  let mutationObserver = null;

  // --- Selectors ---

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
    if (el.id) return `#${el.id}`;
    const parts = [];
    let current = el;
    while (current && current.tagName) {
      let selector = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${current.id}`);
        break;
      }
      if (current.className && typeof current.className === 'string') {
        const classes = Array.from(current.classList).slice(0, 2).join('.');
        if (classes) selector += `.${classes}`;
      }
      parts.unshift(selector);
      current = current.parentElement;
      if (parts.length > 4) break;
    }
    return parts.join(' > ');
  }

  function getDataAttributes(el) {
    const data = {};
    if (!el.dataset) return data;
    for (const [key, value] of Object.entries(el.dataset)) {
      data[key] = value;
    }
    return data;
  }

  function isInShadowDOM(el) {
    return el.getRootNode() instanceof ShadowRoot;
  }

  function getShadowHost(el) {
    const root = el.getRootNode();
    if (root instanceof ShadowRoot) return getCSSSelector(root.host);
    return null;
  }

  // --- Sensitive Field Detection ---

  const SENSITIVE_INDICATORS = ['password', 'credit', 'cc-', 'cvv', 'cvc', 'ssn', 'social', 'secret', 'token'];

  function isSensitiveField(el) {
    const indicators = [el.type, el.name, el.id, el.autocomplete, el.placeholder]
      .filter(Boolean)
      .map(v => v.toLowerCase());
    return SENSITIVE_INDICATORS.some(s => indicators.some(i => i.includes(s)));
  }

  // --- Element Info ---

  function elementInfo(el) {
    if (!el || !el.tagName) return null;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classList: el.classList ? Array.from(el.classList) : [],
      name: el.name || null,
      text: el.innerText?.trim()?.slice(0, 100) || null,
      value: el.value || null,
      href: el.href || null,
      type: el.type || null,
      placeholder: el.placeholder || null,
      autocomplete: el.autocomplete || null,
      ariaLabel: el.getAttribute('aria-label') || null,
      dataAttributes: getDataAttributes(el),
      xpath: getXPath(el),
      cssSelector: getCSSSelector(el),
      isInShadowDOM: isInShadowDOM(el),
      shadowHost: getShadowHost(el),
      formAction: el.form?.action || null,
      formMethod: el.form?.method?.toUpperCase() || null
    };
  }

  // --- Event Handlers ---

  function handleClick(e) {
    if (!capturing) return;
    const el = e.target;
    if (el.closest?.('#agentscribe-overlay') || el.closest?.('#agentscribe-tooltip')) return;

    sendEvent({
      type: 'click',
      timestamp: Date.now(),
      url: window.location.href,
      element: elementInfo(el),
      coordinates: { x: e.clientX, y: e.clientY },
      isTrusted: e.isTrusted
    });
  }

  function handleInput(e) {
    if (!capturing) return;
    const el = e.target;
    const sensitive = isSensitiveField(el);
    const logSensitive = settings?.logSensitiveValues || false;

    sendEvent({
      type: 'input',
      timestamp: Date.now(),
      url: window.location.href,
      action: e.type,
      element: elementInfo(el),
      value: (sensitive && !logSensitive) ? '[REDACTED]' : (el.value || ''),
      flag: isInputElement(el) ? 'INJECTABLE_POINT' : null
    });
  }

  function handlePaste(e) {
    if (!capturing) return;
    const el = e.target;
    const sensitive = isSensitiveField(el);
    const logSensitive = settings?.logSensitiveValues || false;

    sendEvent({
      type: 'paste',
      timestamp: Date.now(),
      url: window.location.href,
      element: elementInfo(el),
      value: (sensitive && !logSensitive) ? '[REDACTED]' : (e.clipboardData?.getData('text')?.slice(0, 500) || ''),
      flag: isInputElement(el) ? 'INJECTABLE_POINT' : null
    });
  }

  function handleKeydown(e) {
    if (!capturing) return;
    if (e.key !== 'Enter' && e.key !== 'Tab') return;

    sendEvent({
      type: 'keydown',
      timestamp: Date.now(),
      url: window.location.href,
      key: e.key,
      element: elementInfo(e.target),
      isTrusted: e.isTrusted
    });
  }

  function handleFocusBlur(e) {
    if (!capturing) return;
    if (!settings?.captureFocusBlur) return;

    sendEvent({
      type: e.type,
      timestamp: Date.now(),
      url: window.location.href,
      element: elementInfo(e.target)
    });
  }

  function handleScroll() {
    if (!capturing) return;
    if (!settings?.captureScrolls) return;

    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(() => {
      sendEvent({
        type: 'scroll',
        timestamp: Date.now(),
        url: window.location.href,
        scrollX: Math.round(window.scrollX),
        scrollY: Math.round(window.scrollY),
        element: null
      });
    }, 500);
  }

  // --- Field Scanning ---

  function scanFields() {
    const scanner = window.__agentscribe?.scanFields;
    if (scanner) {
      const fields = scanner(document, null, window.location.href);
      fieldMap = new Map(fields.map(f => [f.xpath, f]));
      chrome.runtime.sendMessage({ type: 'FIELD_SCAN_RESULTS', fields });
      return;
    }

    const results = [];
    const selectors = 'input, textarea, select, [contenteditable="true"]';
    document.querySelectorAll(selectors).forEach(el => {
      if (el.type === 'hidden') return;
      const field = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        tabId: null,
        url: window.location.href,
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
        purposeInferred: 'Unknown — review manually',
        isInShadowDOM: isInShadowDOM(el),
        shadowHostSelector: getShadowHost(el),
        isSensitive: isSensitiveField(el),
        flag: 'INJECTABLE_POINT'
      };
      results.push(field);
    });

    scanShadowRoots(document, results);

    fieldMap = new Map(results.map(f => [f.xpath, f]));
    chrome.runtime.sendMessage({ type: 'FIELD_SCAN_RESULTS', fields: results });
  }

  function scanShadowRoots(root, results) {
    root.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        el.shadowRoot.querySelectorAll('input, textarea, select, [contenteditable="true"]').forEach(shadowEl => {
          if (shadowEl.type === 'hidden') return;
          results.push({
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            tabId: null,
            url: window.location.href,
            tag: shadowEl.tagName.toLowerCase(),
            type: shadowEl.type || null,
            id_attr: shadowEl.id || null,
            name: shadowEl.name || null,
            placeholder: shadowEl.placeholder || null,
            autocomplete: shadowEl.autocomplete || null,
            ariaLabel: shadowEl.getAttribute('aria-label') || null,
            xpath: getXPath(shadowEl),
            cssSelector: getCSSSelector(shadowEl),
            formAction: shadowEl.form?.action || null,
            formMethod: shadowEl.form?.method?.toUpperCase() || null,
            postParamName: shadowEl.name || shadowEl.id || null,
            purposeInferred: 'Unknown — review manually',
            isInShadowDOM: true,
            shadowHostSelector: getCSSSelector(el),
            isSensitive: isSensitiveField(shadowEl),
            flag: 'INJECTABLE_POINT'
          });
        });
        scanShadowRoots(el.shadowRoot, results);
      }
    });
  }

  // --- Overlay ---

  function createOverlay() {
    if (window.__agentscribe?.createOverlay) {
      window.__agentscribe.createOverlay();
      return;
    }
    if (document.getElementById('agentscribe-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'agentscribe-overlay';
    overlay.innerHTML = `
      <style>
        @keyframes agentscribe-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        #agentscribe-overlay {
          position: fixed !important; bottom: 16px !important; right: 16px !important;
          background: #1a1a1a !important; border: 1px solid #ef4444 !important;
          border-radius: 8px !important; padding: 8px 12px !important;
          font-family: 'SF Mono','Consolas','Monaco',monospace !important;
          font-size: 12px !important; color: #f8f8f8 !important;
          z-index: 2147483647 !important; pointer-events: none !important;
          display: flex !important; align-items: center !important; gap: 8px !important;
          box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
        }
        #agentscribe-overlay .rec-dot {
          width:8px; height:8px; border-radius:50%; background:#ef4444;
          animation: agentscribe-pulse 1s infinite;
        }
      </style>
      <span class="rec-dot"></span>
      <span id="agentscribe-counter">REC — 0 events</span>
    `;
    document.documentElement.appendChild(overlay);
  }

  function removeOverlay() {
    if (window.__agentscribe?.removeOverlay) {
      window.__agentscribe.removeOverlay();
    }
    const overlay = document.getElementById('agentscribe-overlay');
    if (overlay) overlay.remove();
    const tooltip = document.getElementById('agentscribe-tooltip');
    if (tooltip) tooltip.remove();
  }

  function updateOverlayCount() {
    if (window.__agentscribe?.updateOverlayCount) {
      window.__agentscribe.updateOverlayCount(eventCount);
      return;
    }
    const el = document.getElementById('agentscribe-counter');
    if (el) el.textContent = `REC — ${eventCount} events`;
  }

  // --- Field Hover Tooltip ---

  function handleMouseOver(e) {
    if (!capturing) return;
    const el = e.target;
    if (!isInputElement(el)) return;

    const xpath = getXPath(el);
    const fieldInfo = fieldMap.get(xpath);
    if (!fieldInfo) return;

    if (window.__agentscribe?.showFieldTooltip) {
      window.__agentscribe.showFieldTooltip(el, fieldInfo);
    } else {
      showInlineTooltip(el, fieldInfo);
    }
  }

  function handleMouseOut(e) {
    if (!capturing) return;
    if (!isInputElement(e.target)) return;

    if (window.__agentscribe?.hideFieldTooltip) {
      window.__agentscribe.hideFieldTooltip();
    } else {
      const tip = document.getElementById('agentscribe-tooltip');
      if (tip) tip.style.display = 'none';
    }
  }

  function showInlineTooltip(el, fieldInfo) {
    let tooltip = document.getElementById('agentscribe-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'agentscribe-tooltip';
      tooltip.style.cssText = `
        position:fixed !important; background:#1a1a1a !important;
        border:1px solid #3b82f6 !important; border-radius:6px !important;
        padding:6px 10px !important; font-family:'SF Mono','Consolas',monospace !important;
        font-size:11px !important; color:#93c5fd !important;
        z-index:2147483647 !important; pointer-events:none !important;
        white-space:nowrap !important; box-shadow:0 2px 8px rgba(0,0,0,0.4) !important;
      `;
      document.documentElement.appendChild(tooltip);
    }
    const param = fieldInfo.postParamName || fieldInfo.name || fieldInfo.id_attr || '?';
    const action = fieldInfo.formAction || 'unknown';
    const method = fieldInfo.formMethod || 'POST';
    tooltip.textContent = `INJECTABLE: ${method} param "${param}" → ${action}`;
    const rect = el.getBoundingClientRect();
    tooltip.style.left = `${rect.left}px`;
    tooltip.style.top = `${Math.max(0, rect.top - 32)}px`;
    tooltip.style.display = 'block';
  }

  // --- Capture Control ---

  function startCapturing() {
    if (capturing) return;
    capturing = true;
    eventCount = 0;

    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s) => {
      settings = s || {};
    });

    document.addEventListener('click', handleClick, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('change', handleInput, true);
    document.addEventListener('paste', handlePaste, true);
    document.addEventListener('keydown', handleKeydown, true);
    document.addEventListener('focus', handleFocusBlur, true);
    document.addEventListener('blur', handleFocusBlur, true);
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    document.addEventListener('mouseover', handleMouseOver, true);
    document.addEventListener('mouseout', handleMouseOut, true);

    // Show inline overlay immediately — top frame only (iframes shouldn't paint UI).
    setTimeout(scanFields, 200);

    if (isTopFrame) {
      createOverlay();

      waitForHelpers(600).then((found) => {
        if (!capturing) return;
        if (found && window.__agentscribe?.createOverlay) {
          const inline = document.getElementById('agentscribe-overlay');
          if (inline) inline.remove();
          window.__agentscribe.createOverlay();
          if (typeof window.__agentscribe.updateOverlayCount === 'function') {
            window.__agentscribe.updateOverlayCount(eventCount);
          }
        }
      });
    }

    mutationObserver = new MutationObserver((mutations) => {
      let hasNewNodes = false;
      for (const m of mutations) {
        if (m.addedNodes.length > 0) { hasNewNodes = true; break; }
      }
      if (hasNewNodes) {
        clearTimeout(mutationObserver._debounce);
        mutationObserver._debounce = setTimeout(scanFields, 500);
      }
    });
    mutationObserver.observe(document.body || document.documentElement, {
      childList: true, subtree: true
    });
  }

  function stopCapturing() {
    if (!capturing) return;
    capturing = false;

    document.removeEventListener('click', handleClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleInput, true);
    document.removeEventListener('paste', handlePaste, true);
    document.removeEventListener('keydown', handleKeydown, true);
    document.removeEventListener('focus', handleFocusBlur, true);
    document.removeEventListener('blur', handleFocusBlur, true);
    document.removeEventListener('scroll', handleScroll, { capture: true });
    document.removeEventListener('mouseover', handleMouseOver, true);
    document.removeEventListener('mouseout', handleMouseOut, true);

    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    if (isTopFrame) removeOverlay();
  }

  // Poll for helper scripts. Aborts if recording stops mid-poll.
  function waitForHelpers(maxMs) {
    return new Promise(resolve => {
      const start = Date.now();
      function check() {
        if (!capturing) { resolve(false); return; }
        if (window.__agentscribe?.scanFields && window.__agentscribe?.createOverlay) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= maxMs) {
          resolve(false);
          return;
        }
        setTimeout(check, 50);
      }
      check();
    });
  }

  // --- Helpers ---

  function isInputElement(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' ||
      el.getAttribute('contenteditable') === 'true';
  }

  function sendEvent(event) {
    eventCount++;
    if (isTopFrame) updateOverlayCount();
    try {
      chrome.runtime.sendMessage({ type: 'DOM_EVENT', event });
    } catch (e) {}
  }

  // --- Message Listener ---

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RECORDING_STARTED') startCapturing();
    if (msg.type === 'RECORDING_STOPPED') stopCapturing();
    if (msg.type === 'RESCAN_FIELDS') scanFields();
    if (msg.type === 'SETTINGS_UPDATED') settings = msg.settings || settings;
  });

  // Early bail — don't wake the SW unless a recording is active.
  chrome.storage.local.get(['isRecording'], (data) => {
    if (chrome.runtime.lastError) return;
    if (!data?.isRecording) return;
    // Only start capturing if this tab is being tracked.
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
      if (chrome.runtime.lastError) return;
      if (state?.isRecordingThisTab) startCapturing();
    });
  });
})();
