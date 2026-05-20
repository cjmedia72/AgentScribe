// MANIFEST TODO: add ws-capture.js, storage-snapshot.js, bundle-analyzer.js to web_accessible_resources for chrome.runtime.getURL() to work cross-context.
(() => {
  if (window.__agentscribe_content_loaded) return;
  window.__agentscribe_content_loaded = true;

  // Top-frame check — only the top window paints the overlay UI.
  // Iframes still capture events (per all_frames:true) but don't show overlays.
  const isTopFrame = (() => {
    try { return window.top === window; } catch { return false; }
  })();

  let capturing = false;
  let paused = false;
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
    // Wave 6 hotfix: also probe anti-bot challenge layer on each scan pass.
    runChallengeLayerProbe();

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

  // Inline overlay — self-contained, no dependency on dynamically-injected
  // overlay.js. Includes the elapsed timer baked in. Paints immediately.
  let _overlayStartTime = 0;
  let _overlayTimerInterval = null;
  function createOverlay() {
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
          user-select: none !important;
        }
        #agentscribe-overlay .rec-dot {
          width:8px; height:8px; border-radius:50%; background:#ef4444;
          animation: agentscribe-pulse 1s infinite; flex-shrink:0;
        }
        #agentscribe-overlay.paused { border-color:#f59e0b !important; }
        #agentscribe-overlay.paused .rec-dot {
          background:#f59e0b !important; animation: none !important;
        }
        #agentscribe-overlay .rec-timer { color:#888; margin-left:4px; }
        #agentscribe-overlay .agentscribe-btn {
          pointer-events: auto !important;
          cursor: pointer !important;
          background: transparent !important;
          border: none !important;
          color: #f8f8f8 !important;
          font-size: 14px !important;
          padding: 2px 6px !important;
          border-radius: 4px !important;
          user-select: none !important;
          font-family: monospace !important;
        }
        #agentscribe-overlay .agentscribe-btn:hover {
          background: rgba(255, 255, 255, 0.15) !important;
        }
      </style>
      <button type="button" class="agentscribe-btn" id="agentscribe-pause" title="Pause">⏸</button>
      <button type="button" class="agentscribe-btn" id="agentscribe-stop" title="Stop">⏹</button>
      <span class="rec-dot"></span>
      <span id="agentscribe-counter">REC — 0 events</span>
      <span class="rec-timer" id="agentscribe-timer">0:00</span>
    `;
    (document.body || document.documentElement).appendChild(overlay);

    // Wire pause button
    const pauseBtn = overlay.querySelector('#agentscribe-pause');
    if (pauseBtn) {
      pauseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        paused = !paused;
        applyPausedVisualState();
      }, true);
    }

    // Wire stop button
    const stopBtn = overlay.querySelector('#agentscribe-stop');
    if (stopBtn) {
      stopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          chrome.runtime.sendMessage({ type: 'STOP_RECORDING_FROM_OVERLAY' });
        } catch (_) { /* SW unreachable; nothing to do */ }
      }, true);
    }

    // Start the timer
    _overlayStartTime = Date.now();
    if (_overlayTimerInterval) clearInterval(_overlayTimerInterval);
    _overlayTimerInterval = setInterval(() => {
      const el = document.getElementById('agentscribe-timer');
      if (!el) return;
      const elapsed = Math.floor((Date.now() - _overlayStartTime) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = String(elapsed % 60).padStart(2, '0');
      el.textContent = `${m}:${s}`;
    }, 1000);
  }

  function removeOverlay() {
    const overlay = document.getElementById('agentscribe-overlay');
    if (overlay) overlay.remove();
    const tooltip = document.getElementById('agentscribe-tooltip');
    if (tooltip) tooltip.remove();
    if (_overlayTimerInterval) {
      clearInterval(_overlayTimerInterval);
      _overlayTimerInterval = null;
    }
  }

  function updateOverlayCount() {
    if (window.__agentscribe?.updateOverlayCount) {
      window.__agentscribe.updateOverlayCount(eventCount);
      return;
    }
    const el = document.getElementById('agentscribe-counter');
    if (el) {
      const label = paused ? 'PAUSED' : 'REC';
      el.textContent = `${label} — ${eventCount} events`;
    }
  }

  function applyPausedVisualState() {
    const overlay = document.getElementById('agentscribe-overlay');
    if (overlay) {
      if (paused) overlay.classList.add('paused');
      else overlay.classList.remove('paused');
    }
    const btn = document.getElementById('agentscribe-pause');
    if (btn) {
      btn.textContent = paused ? '▶' : '⏸';
      btn.title = paused ? 'Resume' : 'Pause';
    }
    updateOverlayCount();
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

    // Attach DOM event listeners FIRST — before anything that could throw.
    // This guarantees capture is live even if downstream init fails.
    try {
      chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (s) => {
        settings = s || {};
      });
    } catch (e) { /* runtime unreachable; settings stays null, handlers still fire */ }

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

    // Overlay paints FIRST — before any wave3 init — so user sees the REC
    // indicator instantly. The inline overlay is fully self-contained (timer
    // baked in); no dependency on dynamically-injected overlay.js.
    if (isTopFrame) {
      try { createOverlay(); } catch (e) { /* overlay must never block capture */ }
    }

    // Wave 3 lifecycle hook — runs after overlay so its async init can't
    // delay the visual indicator. Wrapped so any failure here cannot prevent
    // the DOM listeners (already attached above) from operating.
    try { wave3OnStart(); } catch (e) { /* swallow */ }

    setTimeout(scanFields, 200);

    try {
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
    } catch (e) { /* MutationObserver is best-effort; capture is already live */ }
  }

  function stopCapturing() {
    if (!capturing) return;
    capturing = false;
    paused = false;

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
      try { mutationObserver.disconnect(); } catch (e) {}
      mutationObserver = null;
    }

    // Wave 3 lifecycle hook — wrapped so a failure here cannot leave
    // listeners attached or skip overlay teardown.
    try { wave3OnStop(); } catch (e) { /* swallow */ }

    if (isTopFrame) {
      try { removeOverlay(); } catch (e) {}
    }
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
    if (paused) return;
    eventCount++;
    if (isTopFrame) updateOverlayCount();
    try {
      chrome.runtime.sendMessage({ type: 'DOM_EVENT', event });
    } catch (e) {}
  }

  // --- Wave 3: storage snapshot / bundle analyzer / ws-capture wiring ---
  //
  // All logic here is GATED on `capturing`. Fail silently if modules missing.
  // Modules are loaded once and cached. Listeners installed lazily on first
  // startCapturing() call; payloads only sent while capturing is true.

  let _wave3Initialized = false;
  let _snapshotStorageFn = null;       // from storage-snapshot.js
  let _analyzeBundleFn = null;         // from bundle-analyzer.js
  let _wsMessageListenerInstalled = false;
  let _wsScriptInjected = false;
  let _bundleAnalyzedThisPage = false;
  let _pageEventsBound = false;

  async function loadStorageSnapshot() {
    if (_snapshotStorageFn) return _snapshotStorageFn;
    try {
      const url = chrome.runtime.getURL('storage-snapshot.js');
      const mod = await import(url);
      _snapshotStorageFn = mod.snapshotStorage || mod.default?.snapshotStorage || null;
    } catch (e) {
      _snapshotStorageFn = null;
    }
    return _snapshotStorageFn;
  }

  async function loadBundleAnalyzer() {
    if (_analyzeBundleFn) return _analyzeBundleFn;
    try {
      const url = chrome.runtime.getURL('bundle-analyzer.js');
      const mod = await import(url);
      _analyzeBundleFn = mod.analyzeBundle || mod.default?.analyzeBundle || null;
    } catch (e) {
      _analyzeBundleFn = null;
    }
    return _analyzeBundleFn;
  }

  async function runStorageSnapshot(reason) {
    if (!capturing) return;
    try {
      const fn = await loadStorageSnapshot();
      if (!fn || !capturing) return;
      const snapshot = await fn();
      if (!capturing) return;
      chrome.runtime.sendMessage({
        type: 'STORAGE_SNAPSHOT',
        snapshot,
        timestamp: Date.now(),
        url: window.location.href,
        reason: reason || 'unknown'
      });
    } catch (e) { /* swallow */ }
  }

  async function runBundleAnalysis() {
    if (!capturing) return;
    if (_bundleAnalyzedThisPage) return;
    _bundleAnalyzedThisPage = true;
    try {
      const fn = await loadBundleAnalyzer();
      if (!fn || !capturing) return;

      const SCRIPT_LIMIT = 20;
      const BYTE_LIMIT = 2 * 1024 * 1024; // 2MB per script
      const FETCH_TIMEOUT_MS = 5000;

      const scriptEls = Array.from(document.querySelectorAll('script[src]')).slice(0, SCRIPT_LIMIT);
      const scriptUrls = [];
      const scriptSources = [];

      for (const el of scriptEls) {
        const src = el.src;
        if (!src) continue;
        scriptUrls.push(src);
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
          const resp = await fetch(src, { signal: ctrl.signal, credentials: 'omit' });
          clearTimeout(t);
          if (!resp.ok) { scriptSources.push(''); continue; }
          const text = await resp.text();
          scriptSources.push(text.length > BYTE_LIMIT ? text.slice(0, BYTE_LIMIT) : text);
        } catch (e) {
          scriptSources.push('');
        }
        if (!capturing) return;
      }

      const findings = fn({ scriptUrls, scriptSources });
      if (!capturing) return;
      chrome.runtime.sendMessage({
        type: 'BUNDLE_FINDINGS',
        findings,
        url: window.location.href
      });
    } catch (e) { /* swallow */ }
  }

  function injectWsCapture() {
    if (_wsScriptInjected) return;
    try {
      const url = chrome.runtime.getURL('ws-capture.js');
      const script = document.createElement('script');
      script.src = url;
      script.type = 'text/javascript';
      script.async = false;
      script.onload = () => { try { script.remove(); } catch (e) {} };
      (document.head || document.documentElement).appendChild(script);
      _wsScriptInjected = true;
    } catch (e) { /* swallow */ }
  }

  // Wave 6 hotfix: page-context fetch/XHR proxy injection (MAIN world).
  let _fetchScriptInjected = false;
  function injectFetchCapture() {
    if (_fetchScriptInjected) return;
    try {
      const url = chrome.runtime.getURL('fetch-capture.js');
      const script = document.createElement('script');
      script.src = url;
      script.type = 'text/javascript';
      script.async = false;
      script.onload = () => { try { script.remove(); } catch (e) {} };
      (document.head || document.documentElement).appendChild(script);
      _fetchScriptInjected = true;
    } catch (e) { /* swallow */ }
  }

  function handleFetchWindowMessage(e) {
    if (!capturing) return;
    try {
      const data = e.data;
      if (!data || data.source !== 'agentscribe-fetch') return;
      chrome.runtime.sendMessage({ type: 'FETCH_EVENT', payload: data });
    } catch (err) { /* swallow */ }
  }

  // Wave 6 hotfix: anti-bot challenge layer probe.
  // field-scanner.js exposes detectChallengeLayer on window.__agentscribe.
  // We snapshot whatever it returns (or null) and ship via CHALLENGE_LAYER message.
  let _lastChallengeLayerSent = undefined;
  function runChallengeLayerProbe() {
    if (!capturing) return;
    try {
      const fn = window.__agentscribe?.detectChallengeLayer;
      if (typeof fn !== 'function') return;
      let layer = null;
      try { layer = fn(document) || null; } catch (_) { layer = null; }
      // Only send when the value changes — reduces noise on every mutation tick.
      // But always send the first probe so the field is set even if null.
      if (layer === _lastChallengeLayerSent) return;
      _lastChallengeLayerSent = layer;
      chrome.runtime.sendMessage({
        type: 'CHALLENGE_LAYER',
        layer,
        url: window.location.href,
        timestamp: Date.now()
      });
    } catch (e) { /* swallow */ }
  }

  function handleWsWindowMessage(e) {
    if (!capturing) return;
    try {
      const data = e.data;
      if (!data || data.source !== 'agentscribe-ws') return;
      chrome.runtime.sendMessage({ type: 'WS_EVENT', payload: data });
    } catch (err) { /* swallow */ }
  }

  function bindPageEvents() {
    if (_pageEventsBound) return;
    _pageEventsBound = true;
    try {
      // Initial / late DOMContentLoaded snapshot
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          if (capturing) {
            runStorageSnapshot('domcontentloaded');
            // Wave 6: re-probe challenge layer once DOM is parsed.
            runChallengeLayerProbe();
          }
        }, { once: true });
      }
      // Pre-navigation snapshot
      window.addEventListener('pagehide', () => {
        if (capturing) runStorageSnapshot('pagehide');
      });
      // Bundle analysis at page load
      if (document.readyState === 'complete') {
        // already loaded — defer to next tick
        setTimeout(() => { if (capturing) runBundleAnalysis(); }, 0);
      } else {
        window.addEventListener('load', () => {
          if (capturing) {
            runBundleAnalysis();
            // Wave 6: cookies/iframes/scripts may not have settled until load.
            runChallengeLayerProbe();
          }
        }, { once: true });
      }
    } catch (e) { /* swallow */ }
  }

  function wave3OnStart() {
    try {
      // Reset per-page bundle gate when a new recording begins so a fresh
      // session re-analyzes scripts that were already loaded.
      _bundleAnalyzedThisPage = false;

      // Wave 6: reset challenge-layer dedupe so the next session re-probes.
      _lastChallengeLayerSent = undefined;

      // Inject the MAIN-world WS capture script
      injectWsCapture();

      // Wave 6 hotfix: inject MAIN-world fetch/XHR proxy
      injectFetchCapture();

      // Install the window.message listener once
      if (!_wsMessageListenerInstalled) {
        window.addEventListener('message', handleWsWindowMessage);
        // Wave 6: also listen for fetch-capture frames (same envelope pattern).
        window.addEventListener('message', handleFetchWindowMessage);
        _wsMessageListenerInstalled = true;
      }

      // Bind page lifecycle hooks (idempotent)
      bindPageEvents();

      // Capture start = a "begin capturing" event — take an immediate snapshot
      runStorageSnapshot('recording-start');

      // Wave 6: probe the challenge layer at session start.
      // field-scanner.js is injected by background.js as a content script, so
      // window.__agentscribe.detectChallengeLayer is available shortly after
      // RECORDING_STARTED. Probe immediately and again after a tick to catch
      // the case where field-scanner hasn't finished its IIFE yet.
      runChallengeLayerProbe();
      setTimeout(runChallengeLayerProbe, 300);
      setTimeout(runChallengeLayerProbe, 1500);

      // If the page is already loaded, run bundle analysis now
      if (document.readyState === 'complete') {
        setTimeout(() => { if (capturing) runBundleAnalysis(); }, 0);
      }

      _wave3Initialized = true;
    } catch (e) { /* swallow */ }
  }

  function wave3OnStop() {
    // Listeners stay installed; their handlers no-op when !capturing.
    // We just flip flags so the next start re-runs bundle analysis.
    _bundleAnalyzedThisPage = false;
  }

  // Wave 3 lifecycle hooks (wave3OnStart / wave3OnStop) are invoked directly
  // inside startCapturing() / stopCapturing() above, wrapped in try/catch so
  // a hook failure can never block DOM event listener attachment.
  //
  // The previous wrap-and-reassign pattern (replacing the function bindings
  // post-declaration) was removed in v1.0.13 hotfix — it was structurally
  // fragile and any silent failure in a hook could appear as "0 DOM events"
  // even though the listeners themselves were fine.

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
