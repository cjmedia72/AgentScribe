import { correlate } from './correlation-engine.js';
import { inferSessionName, inferStartName } from './session-namer.js';

// --- State (module-scope; rehydrated on SW wake) ---

let isRecording = false;
let activeTabId = null;
let trackedTabIds = new Set();
let pendingRequests = new Map();
let sessionBuffer = null;
let domBuffer = [];
let networkBuffer = [];
let correlationWindowMs = 1000;
let _cachedSettings = null;
let cdpAttached = new Map();

let _lastStorageWrite = 0;
let _lastWriteEventCount = 0;
let _lastWriteNetCount = 0;

const CAPTURE_TYPES = ['XHR', 'Fetch', 'Document', 'Other'];
const SKIP_DOMAINS = ['google-analytics.com', 'doubleclick.net', 'facebook.com/tr', 'amazon-adsystem.com'];
const PENDING_TTL_MS = 60000;

// --- Hydration: restore state from chrome.storage.local on SW wake ---

// Settled-flag hydration. Storage read mutates state only if it wins the race
// vs. the 5s timeout. If timeout fires first, late-arriving storage data is
// discarded — prevents stale-snapshot overwrite of newer in-memory state.
let _hydrationPromise = null;
function hydrateOnce() {
  if (_hydrationPromise) return _hydrationPromise;
  _hydrationPromise = new Promise((resolve) => {
    let settled = false;
    const settle = (label) => {
      if (settled) return;
      settled = true;
      if (label) console.warn(`[AgentScribe] Hydration ${label}; defaults retained`);
      resolve();
    };

    chrome.storage.local.get([
      'isRecording', 'activeTabId', 'trackedTabIds', 'activeSession', 'settings'
    ]).then((data) => {
      if (settled) return; // timeout already won — do not mutate module state
      isRecording = !!data.isRecording;
      activeTabId = data.activeTabId || null;
      trackedTabIds = new Set(data.trackedTabIds || []);
      sessionBuffer = data.activeSession || null;
      _cachedSettings = data.settings || null;
      correlationWindowMs = _cachedSettings?.correlationWindowMs || 1000;
      if (sessionBuffer) {
        domBuffer = (sessionBuffer.events || []).slice();
        networkBuffer = (sessionBuffer.networkEvents || []).slice();
        _lastWriteEventCount = domBuffer.length;
        _lastWriteNetCount = networkBuffer.length;
      }
      settle();
    }).catch((e) => {
      settle(`failed: ${e?.message || e}`);
    });

    setTimeout(() => settle('timed out after 5s'), 5000);
  });
  return _hydrationPromise;
}
hydrateOnce();

// --- Settings ---

async function getSettings() {
  const data = await chrome.storage.local.get('settings');
  return data.settings || {
    maxEvents: null,
    sessionNamePrefix: 'AgentScribe Session',
    captureScrolls: true,
    captureFocusBlur: true,
    logSensitiveValues: false,
    networkMethod: 'cdp',
    mcpExportEnabled: false,
    correlationWindowMs: 1000,
    analyticsFilterDomains: SKIP_DOMAINS,
    autoExportOnCap: false
  };
}

// --- CDP Debugger ---

async function attachCDPDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        cdpAttached.set(tabId, false);
        console.warn(`[AgentScribe] CDP attach failed for tab ${tabId}:`, chrome.runtime.lastError.message);
        reject(chrome.runtime.lastError);
        return;
      }
      chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
        maxTotalBufferSize: 10000000,
        maxResourceBufferSize: 5000000,
        maxPostDataSize: 65536
      }, () => {
        if (chrome.runtime.lastError) {
          cdpAttached.set(tabId, false);
          reject(chrome.runtime.lastError);
          return;
        }
        cdpAttached.set(tabId, true);
        resolve();
      });
    });
  });
}

async function detachCDPDebugger(tabId) {
  cdpAttached.delete(tabId);
  return new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      if (chrome.runtime.lastError) {
        // ignore: likely already detached
      }
      resolve();
    });
  });
}

function shouldCaptureRequest(req) {
  if (!CAPTURE_TYPES.includes(req.resourceType)) return false;
  const skipDomains = _cachedSettings?.analyticsFilterDomains || SKIP_DOMAINS;
  if (skipDomains.some(d => req.url.includes(d))) return false;
  return true;
}

// --- CDP Event Listener (composite tabId:requestId key) ---

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  await hydrateOnce();
  if (!isRecording) return;
  if (!trackedTabIds.has(source.tabId)) return;

  const key = `${source.tabId}:${params.requestId}`;

  if (method === 'Network.requestWillBeSent') {
    pendingRequests.set(key, {
      requestId: params.requestId,
      url: params.request.url,
      method: params.request.method,
      headers: params.request.headers,
      postData: params.request.postData || null,
      postDataParsed: tryParseJSON(params.request.postData),
      resourceType: params.type,
      timestamp: Date.now(),
      tabId: source.tabId,
      source: 'cdp'
    });
  } else if (method === 'Network.responseReceived') {
    const pending = pendingRequests.get(key);
    if (pending) {
      pending.responseStatus = params.response.status;
      pending.responseHeaders = params.response.headers;
      pending.mimeType = params.response.mimeType;
    }
  } else if (method === 'Network.loadingFinished') {
    const pending = pendingRequests.get(key);
    if (pending && shouldCaptureRequest(pending)) {
      chrome.debugger.sendCommand(
        { tabId: source.tabId },
        'Network.getResponseBody',
        { requestId: params.requestId },
        (response) => {
          if (chrome.runtime.lastError) {
            pending.responseBody = null;
          } else {
            pending.responseBody = response?.body || null;
            pending.responseBodyParsed = tryParseJSON(response?.body);
            pending.responseBase64 = response?.base64Encoded || false;
          }
          finalizeNetworkEvent(pending);
          pendingRequests.delete(key);
        }
      );
    } else {
      pendingRequests.delete(key);
    }
  } else if (method === 'Network.loadingFailed') {
    pendingRequests.delete(key);
  }
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  await hydrateOnce();
  cdpAttached.delete(source.tabId);
  if (isRecording && trackedTabIds.has(source.tabId)) {
    console.warn(`[AgentScribe] Debugger detached from tab ${source.tabId}: ${reason}`);
    if (reason === 'canceled_by_user') {
      // User clicked the yellow "Cancel" bar. Treat as stop.
      stopRecording();
    }
  }
});

function finalizeNetworkEvent(netEvent) {
  const event = {
    id: crypto.randomUUID(),
    ...netEvent,
    correlatedToDomEventId: null
  };
  networkBuffer.push(event);
  addToSession('networkEvents', event);
}

// --- webRequest Fallback ---

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!isRecording || !trackedTabIds.has(details.tabId)) return;
    const method = _cachedSettings?.networkMethod || 'cdp';
    const cdpOk = cdpAttached.get(details.tabId);
    // Only capture via webRequest if CDP explicitly failed (false).
    // 'pending' or true means CDP is or will be handling it — skip to avoid duplicates.
    if (method === 'cdp' && cdpOk !== false) return;

    const key = `wr:${details.tabId}:${details.requestId}`;
    const postData = details.requestBody?.raw?.[0]?.bytes
      ? '[binary body]'
      : details.requestBody?.formData
        ? JSON.stringify(details.requestBody.formData)
        : null;

    pendingRequests.set(key, {
      requestId: `wr_${details.requestId}`,
      url: details.url,
      method: details.method,
      headers: {},
      postData,
      postDataParsed: tryParseJSON(postData),
      resourceType: capitalize(details.type || 'other'),
      timestamp: Date.now(),
      tabId: details.tabId,
      source: 'webRequest'
    });
  },
  { urls: ['<all_urls>'] },
  ['requestBody']
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    const key = `wr:${details.tabId}:${details.requestId}`;
    const pending = pendingRequests.get(key);
    if (!pending) return;
    pending.headers = (details.requestHeaders || []).reduce((acc, h) => {
      acc[h.name] = h.value;
      return acc;
    }, {});
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const key = `wr:${details.tabId}:${details.requestId}`;
    const pending = pendingRequests.get(key);
    if (!pending) return;
    pending.responseStatus = details.statusCode;
    pending.responseHeaders = (details.responseHeaders || []).reduce((acc, h) => {
      acc[h.name] = h.value;
      return acc;
    }, {});
    if (shouldCaptureRequest(pending)) {
      finalizeNetworkEvent(pending);
    }
    pendingRequests.delete(key);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    pendingRequests.delete(`wr:${details.tabId}:${details.requestId}`);
  },
  { urls: ['<all_urls>'] }
);

// --- Pending Request TTL Cleanup ---

setInterval(() => {
  if (!isRecording) return;
  const now = Date.now();
  let pruned = 0;
  for (const [key, req] of pendingRequests) {
    if (now - req.timestamp > PENDING_TTL_MS) {
      pendingRequests.delete(key);
      pruned++;
    }
  }
  if (pruned > 0) {
    console.log(`[AgentScribe] Pruned ${pruned} stale pending requests`);
  }
}, 15000);

// --- Tab Following ---

chrome.tabs.onCreated.addListener(async (tab) => {
  await hydrateOnce();
  if (!isRecording) return;
  if (tab.openerTabId && trackedTabIds.has(tab.openerTabId)) {
    trackedTabIds.add(tab.id);
    if (sessionBuffer && !sessionBuffer.tabIds.includes(tab.id)) {
      sessionBuffer.tabIds.push(tab.id);
    }
    await chrome.storage.local.set({ trackedTabIds: [...trackedTabIds] });
    attachCDPToNewTab(tab.id);
  }
});

async function attachCDPToNewTab(tabId) {
  // Honor networkMethod for followed tabs (mirrors startRecording).
  const method = _cachedSettings?.networkMethod || 'cdp';
  if (method === 'webrequest') {
    cdpAttached.set(tabId, false);
  } else {
    cdpAttached.set(tabId, 'pending');
    try {
      await attachCDPDebugger(tabId);
    } catch (e) {
      console.warn(`[AgentScribe] CDP attach failed on followed tab ${tabId}; webRequest fallback active`);
    }
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['field-scanner.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STARTED' }).catch(() => {});
  } catch (e) {
    console.warn(`[AgentScribe] Script injection failed on tab ${tabId}:`, e);
  }
}

// --- webNavigation: nav event + helper re-injection ---

chrome.webNavigation.onCommitted.addListener(async (details) => {
  await hydrateOnce();
  if (!isRecording) return;
  if (!trackedTabIds.has(details.tabId)) return;
  if (details.frameId !== 0) return;

  const navEvent = {
    id: crypto.randomUUID(),
    type: 'navigation',
    timestamp: Date.now(),
    tabId: details.tabId,
    url: details.url,
    transitionType: details.transitionType,
    triggeredRequests: []
  };
  domBuffer.push(navEvent);
  addToSession('events', navEvent);

  // Re-inject helpers — manifest content.js auto-loads; helpers do not
  try {
    await chrome.scripting.executeScript({ target: { tabId: details.tabId }, files: ['field-scanner.js'] });
    await chrome.scripting.executeScript({ target: { tabId: details.tabId }, files: ['overlay.js'] });
  } catch (e) {
    // page may not allow injection (e.g. chrome:// pages)
  }
});

// --- Tab removed: auto-stop on empty ---

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await hydrateOnce();
  if (!isRecording) return;
  if (!trackedTabIds.has(tabId)) return;

  trackedTabIds.delete(tabId);
  cdpAttached.delete(tabId);
  // Debugger auto-detaches when tab closes — no explicit detach needed

  if (trackedTabIds.size === 0) {
    console.log('[AgentScribe] All tracked tabs closed — auto-stopping recording');
    await stopRecording();
  } else {
    await chrome.storage.local.set({ trackedTabIds: [...trackedTabIds] });
  }
});

// --- Settings change propagation ---

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!changes.settings) return;
  _cachedSettings = changes.settings.newValue;
  correlationWindowMs = _cachedSettings?.correlationWindowMs || 1000;
  if (isRecording) {
    for (const tabId of trackedTabIds) {
      chrome.tabs.sendMessage(tabId, { type: 'SETTINGS_UPDATED', settings: _cachedSettings }).catch(() => {});
    }
  }
});

// --- Recording Control ---

async function startRecording(tabId) {
  await hydrateOnce();
  // Don't race a stop-in-flight. Wait for it to fully settle so our
  // isRecording=true doesn't get overwritten back to false.
  if (_stoppingPromise) {
    try { await _stoppingPromise; } catch {}
  }
  const settings = await getSettings();
  _cachedSettings = settings;
  correlationWindowMs = settings.correlationWindowMs || 1000;

  activeTabId = tabId;
  trackedTabIds = new Set([tabId]);
  pendingRequests = new Map();
  cdpAttached = new Map();
  domBuffer = [];
  networkBuffer = [];
  isRecording = true;

  const tab = await chrome.tabs.get(tabId);

  sessionBuffer = {
    id: crypto.randomUUID(),
    version: '1.0',
    name: inferStartName(tab.url),
    startTime: Date.now(),
    endTime: null,
    startUrl: tab.url,
    tabIds: [tabId],
    eventCount: 0,
    events: [],
    networkEvents: [],
    injectableFields: [],
    apiEndpoints: [],
    droppedEvents: 0
  };

  _lastStorageWrite = Date.now();
  _lastWriteEventCount = 0;
  _lastWriteNetCount = 0;

  await chrome.storage.local.set({
    activeSession: sessionBuffer,
    isRecording: true,
    activeTabId: tabId,
    trackedTabIds: [...trackedTabIds]
  });

  const networkMethod = settings.networkMethod || 'cdp';
  if (networkMethod === 'webrequest') {
    // Explicit "no CDP" — mark false so webRequest path captures.
    cdpAttached.set(tabId, false);
  } else {
    // Mark pending before await so webRequest doesn't double-capture during the attach window.
    cdpAttached.set(tabId, 'pending');
    try { await attachCDPDebugger(tabId); }
    catch (e) { console.warn('[AgentScribe] CDP attach failed; webRequest fallback active'); }
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['field-scanner.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['overlay.js'] });
  } catch (e) {
    console.warn('[AgentScribe] Helper script injection failed:', e);
  }

  chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STARTED' }).catch(() => {});

  return { success: true, sessionId: sessionBuffer.id };
}

// Closure-local promise reference prevents overwrite-wipe under concurrent
// stops. Each invocation owns its own promise; the global pointer is only
// cleared if it still matches the current invocation's promise.
let _stoppingPromise = null;
async function stopRecording() {
  if (_stoppingPromise) {
    try { await _stoppingPromise; } catch {}
  }
  const myPromise = (async () => {
    await hydrateOnce();
    if (!isRecording) return { success: false };
    return _stopRecordingImpl();
  })();
  _stoppingPromise = myPromise;
  try { return await myPromise; }
  finally {
    if (_stoppingPromise === myPromise) _stoppingPromise = null;
  }
}

async function _stopRecordingImpl() {
  isRecording = false;

  for (const tabId of trackedTabIds) {
    await detachCDPDebugger(tabId).catch(() => {});
    chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STOPPED' }).catch(() => {});
  }

  if (!sessionBuffer) {
    await chrome.storage.local.set({ isRecording: false, activeTabId: null, trackedTabIds: [] });
    return { success: false, reason: 'no_session' };
  }

  const result = correlate(domBuffer, networkBuffer, correlationWindowMs);
  sessionBuffer.events = result.domEvents;
  sessionBuffer.networkEvents = result.networkEvents;
  sessionBuffer.endTime = Date.now();
  sessionBuffer.eventCount = sessionBuffer.events.length;

  // Smart name inferred from captured events — runs AFTER correlation so
  // triggeredRequests are populated and search terms / button clicks are present.
  try {
    sessionBuffer.name = inferSessionName(sessionBuffer);
  } catch (e) {
    console.warn('[AgentScribe] Name inference failed, keeping placeholder:', e);
  }

  const uniqueEndpoints = new Set();
  sessionBuffer.networkEvents.forEach(n => {
    try { uniqueEndpoints.add(`${n.method} ${new URL(n.url).pathname}`); }
    catch { uniqueEndpoints.add(`${n.method} ${n.url}`); }
  });
  sessionBuffer.apiEndpoints = [...uniqueEndpoints];

  const stored = await chrome.storage.local.get('completedSessions');
  const completed = stored.completedSessions || [];
  completed.unshift(sessionBuffer);
  if (completed.length > 20) completed.length = 20;

  await chrome.storage.local.set({
    completedSessions: completed,
    lastSession: sessionBuffer,
    activeSession: null,
    isRecording: false,
    activeTabId: null,
    trackedTabIds: []
  });

  const sessionResult = {
    id: sessionBuffer.id,
    name: sessionBuffer.name,
    duration: sessionBuffer.endTime - sessionBuffer.startTime,
    domEventCount: sessionBuffer.events.length,
    networkEventCount: sessionBuffer.networkEvents.length,
    fieldCount: sessionBuffer.injectableFields.length,
    droppedEvents: sessionBuffer.droppedEvents || 0
  };

  trackedTabIds = new Set();
  activeTabId = null;
  pendingRequests = new Map();
  cdpAttached = new Map();
  domBuffer = [];
  networkBuffer = [];
  sessionBuffer = null;

  return { success: true, session: sessionResult };
}

// --- Session Storage ---

async function addToSession(key, event) {
  if (!sessionBuffer) return;
  if (!key || !sessionBuffer[key]) return;

  const settings = _cachedSettings || await getSettings();
  const maxEvents = settings.maxEvents || null;

  if (maxEvents) {
    const total = sessionBuffer.events.length + sessionBuffer.networkEvents.length;
    if (total >= maxEvents) {
      if (settings.autoExportOnCap) {
        await autoExportSegment();
      } else {
        if (!sessionBuffer._capWarned) {
          sessionBuffer._capWarned = true;
          sessionBuffer.cappedAt = Date.now();
          console.warn(`[AgentScribe] Event cap (${maxEvents}) reached. Subsequent events dropped. Enable auto-export or raise the cap.`);
        }
        sessionBuffer.droppedEvents = (sessionBuffer.droppedEvents || 0) + 1;
        return;
      }
    }
  }

  sessionBuffer[key].push(event);
  sessionBuffer.eventCount = sessionBuffer.events.length;
  maybePersistSession();
}

async function maybePersistSession({ force = false } = {}) {
  if (!sessionBuffer) return;
  const now = Date.now();
  const elapsed = now - _lastStorageWrite;
  const eventDelta = sessionBuffer.events.length - _lastWriteEventCount;
  const networkDelta = sessionBuffer.networkEvents.length - _lastWriteNetCount;

  if (!force && elapsed < 2000 && eventDelta < 50 && networkDelta < 25) return;

  _lastStorageWrite = now;
  _lastWriteEventCount = sessionBuffer.events.length;
  _lastWriteNetCount = sessionBuffer.networkEvents.length;
  await chrome.storage.local.set({ activeSession: sessionBuffer });
}

async function autoExportSegment() {
  // Run correlation on the current buffer before export.
  const result = correlate(domBuffer, networkBuffer, correlationWindowMs);
  const segment = {
    ...sessionBuffer,
    events: result.domEvents,
    networkEvents: result.networkEvents,
    endTime: Date.now(),
    name: `${sessionBuffer.name} [segment ${new Date().toISOString()}]`
  };

  const { exportJSON } = await import('./exporters/json-exporter.js');
  exportJSON(segment);

  sessionBuffer.events = [];
  sessionBuffer.networkEvents = [];
  sessionBuffer.injectableFields = [];
  sessionBuffer.eventCount = 0;
  // Reset cap-warning state so the next segment can re-warn.
  sessionBuffer._capWarned = false;
  sessionBuffer.cappedAt = null;
  sessionBuffer.droppedEvents = 0;
  domBuffer = [];
  networkBuffer = [];
  _lastWriteEventCount = 0;
  _lastWriteNetCount = 0;
  await chrome.storage.local.set({ activeSession: sessionBuffer });
}

// --- Export Handling ---

async function handleExport(format, session) {
  let exporter;
  switch (format) {
    case 'json':
      exporter = await import('./exporters/json-exporter.js');
      return exporter.exportJSON(session);
    case 'playwright':
      exporter = await import('./exporters/playwright-exporter.js');
      return exporter.exportPlaywright(session);
    case 'postman':
      exporter = await import('./exporters/postman-exporter.js');
      return exporter.exportPostman(session);
    case 'sop':
      exporter = await import('./exporters/sop-exporter.js');
      return exporter.exportSOP(session);
    case 'mcp':
      exporter = await import('./exporters/mcp-exporter.js');
      return exporter.exportMCP(session);
    default:
      return { error: `Unknown format: ${format}` };
  }
}

// --- Message Handling ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.tabId).then(sendResponse);
    return true;
  }

  if (msg.type === 'STOP_RECORDING') {
    stopRecording().then(sendResponse);
    return true;
  }

  if (msg.type === 'GET_STATE') {
    (async () => {
      await hydrateOnce();
      const senderTabId = sender.tab?.id;
      sendResponse({
        isRecording,
        activeTabId,
        // Tab-aware: content scripts gate on this; popup gets full view
        isRecordingThisTab: senderTabId
          ? trackedTabIds.has(senderTabId)
          : isRecording,
        trackedTabIds: [...trackedTabIds],
        domEventCount: domBuffer.length,
        networkEventCount: networkBuffer.length,
        fieldCount: sessionBuffer?.injectableFields?.length || 0,
        droppedEvents: sessionBuffer?.droppedEvents || 0,
        capWarned: sessionBuffer?._capWarned || false,
        lastDomEvent: domBuffer[domBuffer.length - 1] || null,
        lastNetworkEvent: networkBuffer[networkBuffer.length - 1] || null
      });
    })();
    return true;
  }

  if (msg.type === 'EXPORT') {
    (async () => {
      await hydrateOnce();
      let session;
      if (msg.sessionId) {
        const stored = await chrome.storage.local.get('completedSessions');
        session = (stored.completedSessions || []).find(s => s.id === msg.sessionId);
      } else {
        const stored = await chrome.storage.local.get('lastSession');
        session = stored.lastSession;
      }
      if (!session) {
        sendResponse({ error: 'No session found' });
        return;
      }
      const result = await handleExport(msg.format, session);
      sendResponse(result);
    })();
    return true;
  }

  if (msg.type === 'DOM_EVENT') {
    (async () => {
      await hydrateOnce();
      if (!isRecording) return;
      const senderTabId = sender.tab?.id;
      // Drop events from non-tracked tabs even if they slip through
      if (senderTabId && !trackedTabIds.has(senderTabId)) return;
      const event = {
        id: crypto.randomUUID(),
        ...msg.event,
        tabId: senderTabId,
        triggeredRequests: []
      };
      domBuffer.push(event);
      addToSession('events', event);
    })();
    return false;
  }

  if (msg.type === 'FIELD_SCAN_RESULTS') {
    (async () => {
      await hydrateOnce();
      if (!isRecording || !sessionBuffer) return;
      const senderTabId = sender.tab?.id;
      if (senderTabId && !trackedTabIds.has(senderTabId)) return;
      const fields = msg.fields || [];
      const existing = new Set(sessionBuffer.injectableFields.map(f => f.xpath));
      const newFields = fields.filter(f => !existing.has(f.xpath));
      sessionBuffer.injectableFields.push(...newFields);
      maybePersistSession();
    })();
    return false;
  }

  if (msg.type === 'GET_SETTINGS') {
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.type === 'GET_LAST_SESSION') {
    chrome.storage.local.get('lastSession').then(data => {
      sendResponse(data.lastSession || null);
    });
    return true;
  }

  if (msg.type === 'GET_COMPLETED_SESSIONS') {
    chrome.storage.local.get('completedSessions').then(data => {
      sendResponse(data.completedSessions || []);
    });
    return true;
  }

  if (msg.type === 'CLEAR_SESSIONS') {
    chrome.storage.local.remove(['completedSessions', 'lastSession']).then(() => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (msg.type === 'DELETE_SESSION') {
    (async () => {
      const stored = await chrome.storage.local.get(['completedSessions', 'lastSession']);
      const completed = (stored.completedSessions || []).filter(s => s.id !== msg.sessionId);
      const updates = { completedSessions: completed };
      if (stored.lastSession?.id === msg.sessionId) {
        updates.lastSession = completed[0] || null;
      }
      await chrome.storage.local.set(updates);
      sendResponse({ success: true });
    })();
    return true;
  }
});

// --- Utility ---

function tryParseJSON(str) {
  if (!str || typeof str !== 'string') return null;
  try { return JSON.parse(str); }
  catch { return null; }
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// --- Keyboard shortcut (Ctrl+Shift+R / Cmd+Shift+R) toggles recording ---

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-recording') return;
  await hydrateOnce();
  if (isRecording) {
    await stopRecording();
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await startRecording(tab.id);
  }
});

// --- Init ---

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get('settings');
  if (!existing.settings) {
    await chrome.storage.local.set({
      settings: {
        maxEvents: null,
        sessionNamePrefix: 'AgentScribe Session',
        captureScrolls: true,
        captureFocusBlur: true,
        logSensitiveValues: false,
        networkMethod: 'cdp',
        mcpExportEnabled: false,
        correlationWindowMs: 1000,
        analyticsFilterDomains: ['google-analytics.com', 'doubleclick.net', 'facebook.com/tr', 'amazon-adsystem.com', 'quantummetric.com', 'fullstory.com'],
        autoExportOnCap: false
      },
      completedSessions: [],
      isRecording: false
    });
  } else {
    // Crash-recovery: if SW was killed mid-recording, clear stale state
    await chrome.storage.local.set({
      isRecording: false,
      activeTabId: null,
      trackedTabIds: [],
      activeSession: null
    });
  }
});
