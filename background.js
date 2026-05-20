import { correlate, inferPagination, tagMutation } from './correlation-engine.js';
import { inferSessionName, inferStartName } from './session-namer.js';
import { classifyRequest, classifyHeader } from './auth-detector.js';

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

// --- Cookie snapshot (v1.0.13 — full state capture) ---

async function snapshotCookies(url) {
  if (!url) return [];
  try {
    return await chrome.cookies.getAll({ url });
  } catch (e) {
    console.warn('[AgentScribe] cookie snapshot failed:', e?.message || e);
    return [];
  }
}

async function recordCookieSnapshot(url, trigger) {
  if (!sessionBuffer) return;
  if (!sessionBuffer.cookieSnapshots) sessionBuffer.cookieSnapshots = [];
  const cookies = await snapshotCookies(url);
  sessionBuffer.cookieSnapshots.push({
    timestamp: Date.now(),
    url,
    trigger,
    cookies
  });
  maybePersistSession();
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

  // v1.0.13 Wave 3: enrich with auth-detector classification. Wrapped so a
  // classifier exception cannot break the capture pipeline.
  try {
    const cookieSnap = sessionBuffer?.cookieSnapshots;
    const cookies = (cookieSnap && cookieSnap.length > 0)
      ? (cookieSnap[cookieSnap.length - 1].cookies || [])
      : [];
    const storageSnap = sessionBuffer?.storageSnapshots;
    const storageSnapshot = (storageSnap && storageSnap.length > 0)
      ? (storageSnap[storageSnap.length - 1].snapshot || {})
      : {};
    event.auth_classification = classifyRequest({
      headers: event.headers || {},
      cookies,
      storageSnapshot,
      url: event.url,
      method: event.method
    });
  } catch (e) {
    console.warn('[AgentScribe] auth-detector classifyRequest failed:', e?.message || e);
    event.auth_classification = null;
  }

  // Wave 6 hotfix: wire inferPagination (correlation-engine.js).
  // Result feeds mcp-exporter#buildPaginationStrategies via ev.pagination.
  try {
    event.pagination = inferPagination(event);
  } catch (e) {
    console.warn('[AgentScribe] inferPagination failed:', e?.message || e);
    event.pagination = null;
  }

  // Wave 6 hotfix: wire tagMutation (correlation-engine.js).
  // Result feeds mcp-exporter#buildSemanticEndpoints via r.mutates_state.
  try {
    event.mutates_state = tagMutation(event);
  } catch (e) {
    console.warn('[AgentScribe] tagMutation failed:', e?.message || e);
    event.mutates_state = null;
  }

  networkBuffer.push(event);
  addToSession('networkEvents', event);
}

// v1.0.13 Wave 3: session-level auth profile aggregation.
// Walks all network events with auth_classification, picks the highest-
// confidence scheme, lists all sources/refresh endpoints/CSRF sources/JWTs.
function aggregateAuthProfile(networkEvents) {
  const profile = {
    auth_scheme: 'none',
    confidence: 0,
    auth_value_sources: [],
    schemes_seen: [],
    jwt_decoded: null,
    expires_at: null,
    refresh_endpoint_candidates: [],
    csrf_token_sources: []
  };
  if (!Array.isArray(networkEvents) || networkEvents.length === 0) return profile;

  const sourceSet = new Set();
  const schemeSet = new Set();
  const refreshSet = new Set();
  const csrfSet = new Set();
  let bestConfidence = -1;
  let bestJwt = null;
  let bestExpiresAt = null;

  for (const ev of networkEvents) {
    const a = ev && ev.auth_classification;
    if (!a) continue;
    if (a.auth_scheme && a.auth_scheme !== 'none') schemeSet.add(a.auth_scheme);
    if (a.auth_value_source) sourceSet.add(a.auth_value_source);
    if (a.refresh_endpoint_hint) refreshSet.add(a.refresh_endpoint_hint);
    if (a.csrf_token_source) csrfSet.add(a.csrf_token_source);
    const conf = typeof a.confidence === 'number' ? a.confidence : 0;
    if (conf > bestConfidence) {
      bestConfidence = conf;
      profile.auth_scheme = a.auth_scheme || 'none';
      profile.confidence = conf;
    }
    if (a.jwt_decoded && !bestJwt) {
      bestJwt = a.jwt_decoded;
      bestExpiresAt = a.expires_at || null;
    }
  }

  profile.auth_value_sources = [...sourceSet];
  profile.schemes_seen = [...schemeSet];
  profile.refresh_endpoint_candidates = [...refreshSet];
  profile.csrf_token_sources = [...csrfSet];
  profile.jwt_decoded = bestJwt;
  profile.expires_at = bestExpiresAt;
  return profile;
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
  ['requestHeaders', 'extraHeaders']
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
  ['responseHeaders', 'extraHeaders']
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
    if (sessionBuffer) {
      if (!sessionBuffer.tabIds.includes(tab.id)) {
        sessionBuffer.tabIds.push(tab.id);
      }
      // v1.0.13: record auto-followed tabs for OAuth/payment popups
      if (!sessionBuffer.tabsAttached) sessionBuffer.tabsAttached = [];
      if (!sessionBuffer.tabsAttached.includes(tab.id)) {
        sessionBuffer.tabsAttached.push(tab.id);
      }
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

  // v1.0.13: cookie snapshot on each navigation
  await recordCookieSnapshot(details.url, 'navigation');

  // Re-inject helpers — manifest content.js auto-loads; helpers do not
  try {
    await chrome.scripting.executeScript({ target: { tabId: details.tabId }, files: ['field-scanner.js'] });
    await chrome.scripting.executeScript({ target: { tabId: details.tabId }, files: ['overlay.js'] });
  } catch (e) {
    // page may not allow injection (e.g. chrome:// pages)
  }

  // Wave 6 hotfix: on every navigation, trigger a re-scan in the content
  // script. scanFields() now also runs the challenge-layer probe, so the
  // session's challengeLayer field stays current across multi-page sessions.
  try {
    chrome.tabs.sendMessage(details.tabId, { type: 'RESCAN_FIELDS' }).catch(() => {});
  } catch (e) { /* swallow */ }
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
    droppedEvents: 0,
    cookieSnapshots: [],
    tabsAttached: [tabId],
    // v1.0.13 Wave 3: content-script telemetry sinks
    storageSnapshots: [],
    bundleFindings: [],
    wsConnections: [],
    wsFrames: [],
    // v1.0.13 Wave 6 hotfix: anti-bot challenge layer detection +
    // page-context fetch/XHR proxy buffer (secondary; chrome.webRequest is primary).
    challengeLayer: null,
    fetchEvents: []
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

  // v1.0.13: cookie snapshot at session start
  await recordCookieSnapshot(tab.url, 'start');

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
    // Ensure content.js is present in the tab before sending RECORDING_STARTED.
    // The manifest content_scripts entry only injects on NEW page loads — if the
    // user reloaded the extension while on the page, the old content.js is gone
    // and a fresh one isn't there. Without this, the RECORDING_STARTED message
    // is dropped silently and the overlay never appears until the user refreshes.
    // The IIFE guard `window.__agentscribe_content_loaded` prevents double-init.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    console.warn('[AgentScribe] Helper script injection failed:', e);
  }

  // Small delay so content.js's onMessage listener has time to register before
  // we fire RECORDING_STARTED. Without this, on first injection the message
  // can arrive before the listener is wired and gets dropped.
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: 'RECORDING_STARTED' }).catch(() => {});
  }, 50);

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
  // v1.0.13: cookie snapshot at session end (before flipping isRecording)
  if (sessionBuffer) {
    let endUrl = null;
    for (const tabId of trackedTabIds) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t?.url) { endUrl = t.url; break; }
      } catch {}
    }
    if (endUrl) {
      await recordCookieSnapshot(endUrl, 'end');
    }
  }

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

  // v1.0.13 Wave 3: aggregate session-level auth profile from per-event
  // classifications. Wrapped — must not break session finalization.
  try {
    sessionBuffer.authProfile = aggregateAuthProfile(sessionBuffer.networkEvents);
  } catch (e) {
    console.warn('[AgentScribe] aggregateAuthProfile failed:', e?.message || e);
    sessionBuffer.authProfile = null;
  }

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

  // --- v1.0.13 Wave 3: content-script telemetry handlers ---

  if (msg.type === 'STORAGE_SNAPSHOT') {
    (async () => {
      await hydrateOnce();
      if (!isRecording || !sessionBuffer) return;
      const senderTabId = sender.tab?.id;
      if (senderTabId && !trackedTabIds.has(senderTabId)) return;
      if (!sessionBuffer.storageSnapshots) sessionBuffer.storageSnapshots = [];
      sessionBuffer.storageSnapshots.push({
        timestamp: msg.timestamp || Date.now(),
        url: msg.url || sender.tab?.url || null,
        snapshot: msg.snapshot || {}
      });
      maybePersistSession();
    })();
    return false;
  }

  if (msg.type === 'BUNDLE_FINDINGS') {
    (async () => {
      await hydrateOnce();
      if (!isRecording || !sessionBuffer) return;
      const senderTabId = sender.tab?.id;
      if (senderTabId && !trackedTabIds.has(senderTabId)) return;
      if (!sessionBuffer.bundleFindings) sessionBuffer.bundleFindings = [];
      const url = msg.url || sender.tab?.url || null;
      const incoming = msg.findings || {};
      const ts = msg.timestamp || Date.now();
      // Merge with any existing entry for the same URL — concat lists, dedupe.
      const existing = sessionBuffer.bundleFindings.find(b => b.url === url);
      if (existing) {
        const merged = existing.findings || {};
        const mergeListBy = (key, dedupeKeyFn) => {
          const a = Array.isArray(merged[key]) ? merged[key] : [];
          const b = Array.isArray(incoming[key]) ? incoming[key] : [];
          const seen = new Set(a.map(dedupeKeyFn));
          for (const item of b) {
            const k = dedupeKeyFn(item);
            if (!seen.has(k)) { a.push(item); seen.add(k); }
          }
          merged[key] = a;
        };
        const mergeListStr = (key) => {
          const a = Array.isArray(merged[key]) ? merged[key] : [];
          const b = Array.isArray(incoming[key]) ? incoming[key] : [];
          merged[key] = [...new Set([...a, ...b])];
        };
        mergeListStr('api_base_urls');
        mergeListBy('discovered_endpoints', (e) => `${e?.method || ''} ${e?.url_pattern || e?.url || ''}`);
        mergeListBy('signing_functions', (s) => `${s?.name || ''}:${s?.algorithm || ''}:${s?.location || ''}`);
        mergeListStr('refresh_endpoint_candidates');
        mergeListStr('graphql_endpoints');
        existing.findings = merged;
        existing.timestamp = ts;
      } else {
        sessionBuffer.bundleFindings.push({ url, findings: incoming, timestamp: ts });
      }
      maybePersistSession();
    })();
    return false;
  }

  if (msg.type === 'WS_EVENT') {
    (async () => {
      await hydrateOnce();
      if (!isRecording || !sessionBuffer) return;
      const senderTabId = sender.tab?.id;
      if (senderTabId && !trackedTabIds.has(senderTabId)) return;
      if (!sessionBuffer.wsConnections) sessionBuffer.wsConnections = [];
      if (!sessionBuffer.wsFrames) sessionBuffer.wsFrames = [];
      const payload = msg.payload || {};
      const ts = msg.timestamp || Date.now();
      try {
        if (payload.type === 'connect') {
          sessionBuffer.wsConnections.push({
            id: payload.id || crypto.randomUUID(),
            url: payload.url || null,
            protocols: payload.protocols || null,
            tabId: senderTabId || null,
            connectedAt: ts,
            closedAt: null,
            closeCode: null,
            closeReason: null
          });
        } else if (payload.type === 'frame') {
          sessionBuffer.wsFrames.push({
            id: crypto.randomUUID(),
            connectionId: payload.id || null,
            url: payload.url || null,
            direction: payload.direction || null,  // 'send' | 'recv'
            data: payload.data ?? null,
            timestamp: ts,
            tabId: senderTabId || null
          });
        } else if (payload.type === 'close') {
          // Mutate the matching open connection (by id, falling back to url).
          let target = null;
          if (payload.id) {
            target = sessionBuffer.wsConnections.find(c => c.id === payload.id && c.closedAt === null);
          }
          if (!target && payload.url) {
            // last-open match on url
            for (let i = sessionBuffer.wsConnections.length - 1; i >= 0; i--) {
              if (sessionBuffer.wsConnections[i].url === payload.url && sessionBuffer.wsConnections[i].closedAt === null) {
                target = sessionBuffer.wsConnections[i];
                break;
              }
            }
          }
          if (target) {
            target.closedAt = ts;
            target.closeCode = payload.code ?? null;
            target.closeReason = payload.reason ?? null;
          } else {
            // No matching open connection — record an orphan close for diagnostics.
            sessionBuffer.wsConnections.push({
              id: payload.id || crypto.randomUUID(),
              url: payload.url || null,
              protocols: null,
              tabId: senderTabId || null,
              connectedAt: null,
              closedAt: ts,
              closeCode: payload.code ?? null,
              closeReason: payload.reason ?? null,
              orphanClose: true
            });
          }
        }
      } catch (e) {
        console.warn('[AgentScribe] WS_EVENT handler failed:', e?.message || e);
      }
      maybePersistSession();
    })();
    return false;
  }

  // --- v1.0.13 Wave 6 hotfix: challenge layer + fetch proxy ---

  if (msg.type === 'CHALLENGE_LAYER') {
    (async () => {
      await hydrateOnce();
      if (!isRecording || !sessionBuffer) return;
      const senderTabId = sender.tab?.id;
      if (senderTabId && !trackedTabIds.has(senderTabId)) return;
      try {
        // Last-write-wins, but prefer most recent NON-NULL across the session.
        // A null probe from a later page doesn't clobber a positive detection
        // from an earlier page (the agent still needs to know "this session
        // touched Cloudflare somewhere").
        const incoming = msg.layer || null;
        if (incoming) {
          sessionBuffer.challengeLayer = incoming;
        } else if (!sessionBuffer.challengeLayer) {
          // No prior detection AND probe says clear -> record the null so
          // the field is explicitly set rather than undefined.
          sessionBuffer.challengeLayer = null;
        }
        // Also keep a log of probes for diagnostics (bounded).
        if (!sessionBuffer.challengeLayerProbes) sessionBuffer.challengeLayerProbes = [];
        sessionBuffer.challengeLayerProbes.push({
          timestamp: msg.timestamp || Date.now(),
          url: msg.url || sender.tab?.url || null,
          layer: incoming
        });
        if (sessionBuffer.challengeLayerProbes.length > 50) {
          sessionBuffer.challengeLayerProbes.splice(0, sessionBuffer.challengeLayerProbes.length - 50);
        }
      } catch (e) {
        console.warn('[AgentScribe] CHALLENGE_LAYER handler failed:', e?.message || e);
      }
      maybePersistSession();
    })();
    return false;
  }

  if (msg.type === 'FETCH_EVENT') {
    (async () => {
      await hydrateOnce();
      if (!isRecording || !sessionBuffer) return;
      const senderTabId = sender.tab?.id;
      if (senderTabId && !trackedTabIds.has(senderTabId)) return;
      try {
        if (!sessionBuffer.fetchEvents) sessionBuffer.fetchEvents = [];
        const payload = msg.payload || {};
        sessionBuffer.fetchEvents.push({
          id: crypto.randomUUID(),
          tabId: senderTabId || null,
          timestamp: payload.timestamp || Date.now(),
          url: payload.url || null,
          method: payload.method || null,
          api: payload.api || null,               // 'fetch' | 'xhr'
          phase: payload.phase || null,           // 'request' | 'response' | 'error'
          requestId: payload.requestId || null,   // ties request<->response
          requestHeaders: payload.requestHeaders || null,
          requestBody: payload.requestBody || null,
          responseStatus: payload.responseStatus ?? null,
          responseHeaders: payload.responseHeaders || null,
          responseBody: payload.responseBody || null,
          error: payload.error || null
        });
        // Soft cap: don't let runaway page-context capture eat memory.
        if (sessionBuffer.fetchEvents.length > 2000) {
          sessionBuffer.fetchEvents.splice(0, sessionBuffer.fetchEvents.length - 2000);
        }
      } catch (e) {
        console.warn('[AgentScribe] FETCH_EVENT handler failed:', e?.message || e);
      }
      maybePersistSession();
    })();
    return false;
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
