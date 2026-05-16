import { exportJSON } from '../exporters/json-exporter.js';
import { exportPlaywright } from '../exporters/playwright-exporter.js';
import { exportPostman } from '../exporters/postman-exporter.js';
import { exportSOP } from '../exporters/sop-exporter.js';
import { exportMCP } from '../exporters/mcp-exporter.js';
import { exportBundle } from '../exporters/bundle-exporter.js';

const stateIdle = document.getElementById('stateIdle');
const stateRecording = document.getElementById('stateRecording');
const stateExport = document.getElementById('stateExport');
const recBadge = document.getElementById('recBadge');
const settingsBtn = document.getElementById('settingsBtn');

const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnNewRecording = document.getElementById('btnNewRecording');
const btnExportLast = document.getElementById('btnExportLast');
const btnViewSessions = document.getElementById('btnViewSessions');

const domCount = document.getElementById('domCount');
const netCount = document.getElementById('netCount');
const fieldCount = document.getElementById('fieldCount');
const lastDomEvent = document.getElementById('lastDomEvent');
const lastNetEvent = document.getElementById('lastNetEvent');
const recTimer = document.getElementById('recTimer');
const exportSummary = document.getElementById('exportSummary');
const lastSessionInfo = document.getElementById('lastSessionInfo');
const lastSessionStats = document.getElementById('lastSessionStats');
const mcpExportBtn = document.getElementById('mcpExportBtn');
const droppedWarning = document.getElementById('droppedWarning');
const droppedCount = document.getElementById('droppedCount');

let pollInterval = null;
let timerInterval = null;
let recordingStartTime = 0;

function showState(state) {
  stateIdle.style.display = state === 'idle' ? 'block' : 'none';
  stateRecording.style.display = state === 'recording' ? 'block' : 'none';
  stateExport.style.display = state === 'export' ? 'block' : 'none';
  recBadge.classList.toggle('active', state === 'recording');
  settingsBtn.style.display = state === 'recording' ? 'none' : 'inline-flex';
}

// --- Init ---

async function init() {
  const state = await sendMessage({ type: 'GET_STATE' });

  const settings = await sendMessage({ type: 'GET_SETTINGS' });
  if (settings?.mcpExportEnabled) {
    mcpExportBtn.classList.remove('mcp-hidden');
  }

  if (state?.isRecording) {
    showState('recording');
    recordingStartTime = Date.now() - 1000;
    startPolling();
    startTimer();
  } else {
    const lastSession = await sendMessage({ type: 'GET_LAST_SESSION' });
    if (lastSession) {
      showLastSession(lastSession);
    }
    showState('idle');
  }
}

function showLastSession(session) {
  if (!session) return;
  const duration = formatDuration(session.endTime - session.startTime);
  const evts = session.events?.length || 0;
  const nets = session.networkEvents?.length || 0;

  lastSessionInfo.style.display = 'block';
  lastSessionStats.textContent = `${duration} | ${evts} events | ${nets} API calls`;
  btnExportLast.style.display = 'block';
}

// --- Recording ---

btnStart.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  btnStart.disabled = true;
  btnStart.textContent = 'Starting...';

  const result = await sendMessage({ type: 'START_RECORDING', tabId: tab.id });

  if (result?.success) {
    recordingStartTime = Date.now();
    showState('recording');
    startPolling();
    startTimer();
  } else {
    btnStart.disabled = false;
    btnStart.innerHTML = '&#9679; START RECORDING';
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  btnStop.textContent = 'Stopping...';

  const result = await sendMessage({ type: 'STOP_RECORDING' });
  stopPolling();
  stopTimer();

  if (result?.success && result.session) {
    const s = result.session;
    const duration = formatDuration(s.duration);
    exportSummary.textContent = `${duration} | ${s.domEventCount} DOM events | ${s.networkEventCount} API calls | ${s.fieldCount} fields`;
    showState('export');
  } else {
    showState('idle');
  }
});

btnNewRecording.addEventListener('click', () => {
  showState('idle');
  btnStart.disabled = false;
  btnStart.innerHTML = '&#9679; START RECORDING';
});

btnExportLast.addEventListener('click', async () => {
  const lastSession = await sendMessage({ type: 'GET_LAST_SESSION' });
  if (lastSession) {
    const duration = formatDuration(lastSession.endTime - lastSession.startTime);
    const evts = lastSession.events?.length || 0;
    const nets = lastSession.networkEvents?.length || 0;
    const fields = lastSession.injectableFields?.length || 0;
    exportSummary.textContent = `${duration} | ${evts} DOM events | ${nets} API calls | ${fields} fields`;

    const settings = await sendMessage({ type: 'GET_SETTINGS' });
    if (settings?.mcpExportEnabled) {
      mcpExportBtn.classList.remove('mcp-hidden');
    }

    showState('export');
  }
});

// --- Export ---

// Bundle-for-agent button — single tap, all formats packed into one JSON
document.querySelectorAll('.btn-bundle').forEach(btn => {
  btn.addEventListener('click', async () => {
    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';
    try {
      const stored = await chrome.storage.local.get('lastSession');
      const session = stored.lastSession;
      if (!session) throw new Error('No session found');
      const result = exportBundle(session);
      triggerDownload(result.content, result.filename, result.mimeType);
    } catch (e) {
      console.error('[AgentScribe] Bundle error:', e);
      alert(`Bundle failed: ${e.message || e}`);
    }
    setTimeout(() => {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }, 1000);
  });
});

document.querySelectorAll('.export-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const format = btn.dataset.format;
    btn.style.opacity = '0.5';
    btn.style.pointerEvents = 'none';

    try {
      // Fetch last session from storage directly — no SW round-trip
      const stored = await chrome.storage.local.get('lastSession');
      const session = stored.lastSession;
      if (!session) throw new Error('No session found');

      const result = runExporter(format, session);
      if (!result || !result.content) throw new Error(`Unknown format: ${format}`);

      triggerDownload(result.content, result.filename, result.mimeType);
    } catch (e) {
      console.error('[AgentScribe] Export error:', e);
      alert(`Export failed: ${e.message || e}`);
    }

    setTimeout(() => {
      btn.style.opacity = '1';
      btn.style.pointerEvents = 'auto';
    }, 1000);
  });
});

function runExporter(format, session) {
  switch (format) {
    case 'json':       return exportJSON(session);
    case 'playwright': return exportPlaywright(session);
    case 'postman':    return exportPostman(session);
    case 'sop':        return exportSOP(session);
    case 'mcp':        return exportMCP(session);
    default:           return null;
  }
}

function triggerDownload(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// --- Settings ---

settingsBtn.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

btnViewSessions.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('sessions/sessions.html') });
  window.close();
});

// --- Polling ---

function startPolling() {
  pollInterval = setInterval(async () => {
    const state = await sendMessage({ type: 'GET_STATE' });
    if (!state) return;

    domCount.textContent = state.domEventCount || 0;
    netCount.textContent = state.networkEventCount || 0;
    fieldCount.textContent = state.fieldCount || 0;

    if (state.droppedEvents > 0) {
      droppedCount.textContent = state.droppedEvents;
      droppedWarning.classList.add('visible');
    } else {
      droppedWarning.classList.remove('visible');
    }

    if (state.lastDomEvent) {
      const evt = state.lastDomEvent;
      const desc = evt.type + (evt.element?.id ? ` #${evt.element.id}` :
        evt.element?.text ? ` "${evt.element.text.slice(0, 30)}"` :
        evt.element?.tag ? ` <${evt.element.tag}>` : '');
      lastDomEvent.textContent = desc;
    }

    if (state.lastNetworkEvent) {
      const evt = state.lastNetworkEvent;
      let path;
      try { path = new URL(evt.url).pathname; } catch { path = evt.url; }
      lastNetEvent.textContent = `${evt.method} ${path}`;
    }

    if (!state.isRecording) {
      stopPolling();
      stopTimer();
      const result = await sendMessage({ type: 'GET_LAST_SESSION' });
      if (result) {
        const duration = formatDuration(result.endTime - result.startTime);
        exportSummary.textContent = `${duration} | ${result.events?.length || 0} DOM events | ${result.networkEvents?.length || 0} API calls`;
        showState('export');
      } else {
        showState('idle');
      }
    }
  }, 500);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function startTimer() {
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = String(elapsed % 60).padStart(2, '0');
    recTimer.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// --- Helpers ---

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response);
    });
  });
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

init();
