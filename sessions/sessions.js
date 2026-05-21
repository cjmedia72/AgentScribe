import { exportJSON } from '../exporters/json-exporter.js';
import { exportPlaywright } from '../exporters/playwright-exporter.js';
import { exportPostman } from '../exporters/postman-exporter.js';
import { exportSOP } from '../exporters/sop-exporter.js';
import { exportMCP } from '../exporters/mcp-exporter.js';
import { exportBundle, exportBundleLean, wrapLeanForClipboard } from '../exporters/bundle-exporter.js';

const sessionList = document.getElementById('sessionList');
const searchInput = document.getElementById('searchInput');
const searchCount = document.getElementById('searchCount');
const totalSessions = document.getElementById('totalSessions');
const totalEvents = document.getElementById('totalEvents');
const totalApi = document.getElementById('totalApi');
const storageUsed = document.getElementById('storageUsed');
const clearAllBtn = document.getElementById('clearAllBtn');
const backBtn = document.getElementById('backBtn');

let mcpEnabled = false;

async function init() {
  const settings = await sendMessage({ type: 'GET_SETTINGS' });
  mcpEnabled = !!settings?.mcpExportEnabled;

  await renderSessions();
  await updateStorageUsage();
  await refreshDebugPanel();

  // v1.0.13 audit fix: storage.onChanged listener closes the stop-popup race.
  //
  // STOP_RECORDING_FROM_OVERLAY opens this page BEFORE stopRecording() finishes
  // writing the new session to chrome.storage.local (the popup-fallback timer
  // fires at 300ms while the write can take 1-60s on heavy sessions). Without
  // this listener, the freshly-stopped session never appears until the user
  // hits refresh — manifesting as "no data showing" right after they stop.
  //
  // Re-render on any change to completedSessions; debounce to coalesce the
  // typical write-burst (multi-second sessions can trigger several writes in
  // quick succession during finalization).
  let _refreshTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.completedSessions) return;
    clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(() => {
      renderSessions().then(() => {
        applySearchFilter();
        updateStorageUsage();
      }).catch(e => console.error('[AgentScribe] auto-refresh failed:', e));
    }, 150);
  });
}

async function renderSessions() {
  // v1.0.14 hotfix: chrome.runtime.sendMessage has a ~64 MB payload cap.
  // When completedSessions exceeds that (100+ MB observed in the wild), the
  // background-SW round-trip silently drops the response and the page shows
  // 0 sessions despite the data being intact in storage. As an extension
  // page we have direct chrome.storage.local access — bypass the IPC.
  sessionList.innerHTML = `
    <div class="empty-state">
      <div class="icon">&#9203;</div>
      <div class="title">Loading sessions…</div>
      <div class="hint">Reading from chrome.storage.local. Large stores (>50 MB) can take a few seconds.</div>
    </div>
  `;

  let sessions = [];
  try {
    const stored = await chrome.storage.local.get('completedSessions');
    sessions = stored.completedSessions || [];
  } catch (e) {
    console.error('[AgentScribe] renderSessions: storage read failed:', e);
    sessionList.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#9888;</div>
        <div class="title">Failed to load sessions</div>
        <div class="hint">${escapeHtml(e?.message || String(e))}</div>
      </div>
    `;
    return;
  }

  totalSessions.textContent = sessions.length;
  totalEvents.textContent = sessions.reduce((sum, s) => sum + (s.events?.length || 0), 0).toLocaleString();
  totalApi.textContent = sessions.reduce((sum, s) => sum + (s.networkEvents?.length || 0), 0).toLocaleString();

  if (sessions.length === 0) {
    sessionList.innerHTML = `
      <div class="empty-state">
        <div class="icon">&#128190;</div>
        <div class="title">No sessions recorded yet</div>
        <div class="hint">Click the AgentScribe icon and hit START RECORDING to capture your first workflow.</div>
      </div>
    `;
    return;
  }

  sessionList.innerHTML = '';
  sessions.forEach(session => {
    sessionList.appendChild(buildCard(session));
  });
}

function buildCard(session) {
  const card = document.createElement('div');
  card.className = 'session-card';
  card.dataset.sessionId = session.id;

  const date = new Date(session.startTime).toLocaleString();
  const duration = formatDuration((session.endTime || Date.now()) - session.startTime);
  const domCount = session.events?.length || 0;
  const netCount = session.networkEvents?.length || 0;
  const fieldCount = session.injectableFields?.length || 0;
  const droppedCount = session.droppedEvents || 0;

  card.innerHTML = `
    <div class="session-row">
      <div class="session-info">
        <div class="session-name">${escapeHtml(session.name || 'Untitled Session')}</div>
        <div class="session-meta">
          <span class="meta-item">&#128197; ${escapeHtml(date)}</span>
          <span class="meta-item">&#9201; <strong>${duration}</strong></span>
          <span class="meta-item">&#128203; <strong>${domCount}</strong> events</span>
          <span class="meta-item">&#127760; <strong>${netCount}</strong> API</span>
          <span class="meta-item">&#9998; <strong>${fieldCount}</strong> fields</span>
          ${droppedCount > 0 ? `<span class="meta-item" style="color:#f87171">&#9888; ${droppedCount} dropped</span>` : ''}
          ${renderOutcomePill(session)}
        </div>
        <div class="session-url">${escapeHtml(session.startUrl || '')}</div>
        <input type="text" class="session-note-input" placeholder="Add a note (saved automatically)..." value="${escapeHtml(session.note || '')}" maxlength="200" />
      </div>
      <div class="session-actions">
        <button class="preview-btn" title="Preview captured events">&#128065;</button>
        <button class="bundle-btn" data-format="bundle" title="All formats in one JSON file — hand to an agent">&#129302; BUNDLE</button>
        <button class="clipboard-btn" title="Copy bundle to clipboard for agent paste">&#128203;</button>
        <div class="export-group">
          <button class="export-btn" data-format="json" title="Raw JSON">JSON</button>
          <button class="export-btn" data-format="playwright" title="Playwright script">PW</button>
          <button class="export-btn" data-format="postman" title="Postman collection">PM</button>
          <button class="export-btn" data-format="sop" title="SOP markdown">SOP</button>
          <button class="export-btn ${mcpEnabled ? '' : 'mcp-hidden'}" data-format="mcp" title="MCP JSON">MCP</button>
        </div>
        <button class="delete-btn" title="Delete session">&#10005;</button>
      </div>
    </div>
    <div class="toast"></div>
  `;

  card.querySelectorAll('.export-btn').forEach(btn => {
    btn.addEventListener('click', () => exportSession(session.id, btn.dataset.format, card));
  });

  card.querySelector('.bundle-btn')?.addEventListener('click', () => {
    exportSession(session.id, 'bundle', card);
  });

  card.querySelector('.clipboard-btn')?.addEventListener('click', () => {
    // Pass the in-closure session directly — no storage.get await, which
    // would consume the click's user activation before clipboard.writeText.
    copyBundleToClipboard(session, card);
  });

  card.querySelector('.preview-btn')?.addEventListener('click', () => {
    openPreviewModal(session);
  });

  // Per-session note: save on blur, also on debounced input
  const noteInput = card.querySelector('.session-note-input');
  if (noteInput) {
    let noteSaveTimer = null;
    const persistNote = async () => {
      const value = noteInput.value.trim();
      try {
        const stored = await chrome.storage.local.get('completedSessions');
        const sessions = stored.completedSessions || [];
        const idx = sessions.findIndex(s => s.id === session.id);
        if (idx >= 0) {
          sessions[idx].note = value;
          await chrome.storage.local.set({ completedSessions: sessions });
          session.note = value;
        }
      } catch (e) {
        console.error('[AgentScribe] Note save failed:', e);
      }
    };
    noteInput.addEventListener('input', () => {
      clearTimeout(noteSaveTimer);
      noteSaveTimer = setTimeout(persistNote, 600);
    });
    noteInput.addEventListener('blur', persistNote);
  }

  card.querySelector('.delete-btn').addEventListener('click', () => deleteSession(session.id));

  // v1.0.13 additive: outcome-pill cycle + override
  const pill = card.querySelector('.outcome-pill');
  if (pill) {
    pill.addEventListener('click', () => cycleOutcome(session, pill));
  }

  return card;
}

// v1.0.13 additive: outcome pill rendering + cycle
const OUTCOME_CYCLE = ['success', 'failed', 'partial', 'unknown'];
const OUTCOME_LABEL = {
  success:   { glyph: '&#10003;', text: 'Success' },
  failed:    { glyph: '&#10005;', text: 'Failed' },
  partial:   { glyph: '&#9676;',  text: 'Partial' },
  unknown:   { glyph: '?',        text: 'Unknown' },
  uncertain: { glyph: '?',        text: 'Uncertain' }
};

function renderOutcomePill(session) {
  try {
    const outcome = session.outcome || 'uncertain';
    const cls = OUTCOME_LABEL[outcome] ? outcome : 'uncertain';
    const label = OUTCOME_LABEL[cls];
    const userSet = !!session.outcomeUserSet;
    const conf = typeof session.outcomeConfidence === 'number'
      ? ` (${Math.round(session.outcomeConfidence * 100)}%)` : '';
    const title = userSet
      ? `Outcome (manually set) — click to cycle`
      : `Outcome (auto-detected${conf}) — click to cycle`;
    return `<span class="meta-item"><span class="outcome-pill ${cls}${userSet ? ' user-set' : ''}" title="${escapeHtml(title)}">${label.glyph} ${label.text}${userSet ? '<span class="pill-dot"></span>' : ''}</span></span>`;
  } catch (_e) {
    return '';
  }
}

async function cycleOutcome(session, pillEl) {
  try {
    const current = session.outcome || 'uncertain';
    let next;
    if (session.outcomeUserSet) {
      const idx = OUTCOME_CYCLE.indexOf(current);
      if (idx === OUTCOME_CYCLE.length - 1) {
        // After 'unknown' -> back to original heuristic
        next = null; // signal: revert
      } else {
        next = OUTCOME_CYCLE[(idx + 1) % OUTCOME_CYCLE.length];
      }
    } else {
      // First click: start the cycle from Success.
      next = 'success';
    }

    const stored = await chrome.storage.local.get('completedSessions');
    const sessions = stored.completedSessions || [];
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx < 0) return;

    if (next === null) {
      // Revert to original heuristic outcome
      const original = sessions[idx]._outcomeHeuristic || sessions[idx].outcome;
      sessions[idx].outcome = original || 'uncertain';
      sessions[idx].outcomeUserSet = false;
      session.outcome = sessions[idx].outcome;
      session.outcomeUserSet = false;
    } else {
      // Preserve original heuristic on first override
      if (!sessions[idx].outcomeUserSet && !sessions[idx]._outcomeHeuristic) {
        sessions[idx]._outcomeHeuristic = sessions[idx].outcome || 'uncertain';
      }
      sessions[idx].outcome = next;
      sessions[idx].outcomeUserSet = true;
      session.outcome = next;
      session.outcomeUserSet = true;
    }

    await chrome.storage.local.set({ completedSessions: sessions });

    // Re-render just this pill in place
    const fresh = renderOutcomePill(session);
    const wrapper = pillEl.closest('.meta-item');
    if (wrapper) {
      const tmp = document.createElement('div');
      tmp.innerHTML = fresh;
      const newWrap = tmp.firstElementChild;
      if (newWrap) {
        wrapper.replaceWith(newWrap);
        const newPill = newWrap.querySelector('.outcome-pill');
        if (newPill) newPill.addEventListener('click', () => cycleOutcome(session, newPill));
      }
    }
  } catch (e) {
    console.error('[AgentScribe] cycleOutcome failed:', e);
  }
}

async function exportSession(sessionId, format, card) {
  const toast = card.querySelector('.toast');
  const buttons = card.querySelectorAll('.export-btn, .bundle-btn, .delete-btn');
  buttons.forEach(b => b.disabled = true);
  toast.textContent = `Generating ${format.toUpperCase()}...`;
  toast.classList.add('visible');
  toast.style.color = '';

  try {
    // Fetch session from storage directly — no background SW round-trip
    const stored = await chrome.storage.local.get('completedSessions');
    const session = (stored.completedSessions || []).find(s => s.id === sessionId);
    if (!session) throw new Error('Session not found in storage');

    const result = runExporter(format, session);
    if (!result || !result.content) throw new Error(`Unknown format: ${format}`);

    triggerDownload(result.content, result.filename, result.mimeType);
    toast.textContent = `Downloaded: ${result.filename}`;
    toast.style.color = '#86efac';
  } catch (e) {
    console.error('[AgentScribe] Export error:', e);
    toast.textContent = `Error: ${e.message || e}`;
    toast.style.color = '#f87171';
  } finally {
    setTimeout(() => {
      toast.classList.remove('visible');
      toast.style.color = '';
      buttons.forEach(b => b.disabled = false);
    }, 2500);
  }
}

async function copyBundleToClipboard(session, card) {
  // Session is passed in directly — NOT fetched from storage. This means the
  // very first await in this function is clipboard.writeText, so Chrome's
  // transient user activation is still valid when it runs.
  if (!session) {
    showCardToast(card, 'Session data unavailable', true);
    return;
  }

  const toast = card.querySelector('.toast');
  const buttons = card.querySelectorAll('.export-btn, .bundle-btn, .clipboard-btn, .delete-btn, .preview-btn');
  buttons.forEach(b => b.disabled = true);
  toast.textContent = 'Building shim...';
  toast.classList.add('visible');
  toast.style.color = '';

  try {
    // Build lean wrapped payload synchronously — self-contained, no file save needed
    const lean = exportBundleLean(session);
    const payload = wrapLeanForClipboard(session, lean.content);

    // FIRST await is the clipboard write — activation still valid
    await navigator.clipboard.writeText(payload);

    toast.textContent = `Copied ${(payload.length/1024).toFixed(1)} KB to clipboard. Paste into your agent.`;
    toast.style.color = '#86efac';
  } catch (e) {
    console.error('[AgentScribe] Clipboard error:', e);
    toast.textContent = `Failed: ${e.message || e}`;
    toast.style.color = '#f87171';
  } finally {
    setTimeout(() => {
      toast.classList.remove('visible');
      toast.style.color = '';
      buttons.forEach(b => b.disabled = false);
    }, 4000);
  }
}

function showCardToast(card, msg, isError) {
  const toast = card.querySelector('.toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.color = isError ? '#f87171' : '#86efac';
  toast.classList.add('visible');
  setTimeout(() => {
    toast.classList.remove('visible');
    toast.style.color = '';
  }, 3000);
}

function runExporter(format, session) {
  switch (format) {
    case 'json':       return exportJSON(session);
    case 'playwright': return exportPlaywright(session);
    case 'postman':    return exportPostman(session);
    case 'sop':        return exportSOP(session);
    case 'mcp':        return exportMCP(session);
    case 'bundle':     return exportBundle(session);
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

async function deleteSession(sessionId) {
  if (!confirm('Delete this session permanently? This cannot be undone.')) return;
  // v1.0.14: direct storage write — avoid IPC cap on response containing
  // the full sessions array.
  try {
    const stored = await chrome.storage.local.get(['completedSessions', 'lastSession']);
    const completed = (stored.completedSessions || []).filter(s => s.id !== sessionId);
    const updates = { completedSessions: completed };
    if (stored.lastSession?.id === sessionId) {
      updates.lastSession = completed[0] || null;
    }
    await chrome.storage.local.set(updates);
  } catch (e) {
    console.error('[AgentScribe] deleteSession failed:', e);
  }
  await renderSessions();
  await updateStorageUsage();
}

clearAllBtn.addEventListener('click', async () => {
  if (!confirm('Delete ALL saved sessions? This cannot be undone.')) return;
  // v1.0.14: direct storage write.
  try {
    await chrome.storage.local.remove(['completedSessions', 'lastSession']);
  } catch (e) {
    console.error('[AgentScribe] clearAll failed:', e);
  }
  await renderSessions();
  await updateStorageUsage();
});

backBtn.addEventListener('click', (e) => {
  e.preventDefault();
  window.close();
});

// Live search filter — by hostname or session name substring
searchInput?.addEventListener('input', applySearchFilter);

function applySearchFilter() {
  const q = (searchInput?.value || '').trim().toLowerCase();
  const cards = sessionList.querySelectorAll('.session-card');
  let shown = 0;
  cards.forEach(card => {
    if (!q) {
      card.classList.remove('hidden');
      shown++;
      return;
    }
    const name = card.querySelector('.session-name')?.textContent.toLowerCase() || '';
    const url = card.querySelector('.session-url')?.textContent.toLowerCase() || '';
    const note = card.querySelector('.session-note-input')?.value.toLowerCase() || '';
    const match = name.includes(q) || url.includes(q) || note.includes(q);
    card.classList.toggle('hidden', !match);
    if (match) shown++;
  });
  if (searchCount) {
    searchCount.textContent = q ? `${shown} of ${cards.length}` : '';
  }
}

async function updateStorageUsage() {
  chrome.storage.local.getBytesInUse(null, (bytes) => {
    if (bytes < 1024) storageUsed.textContent = `${bytes} B`;
    else if (bytes < 1048576) storageUsed.textContent = `${(bytes / 1024).toFixed(1)} KB`;
    else storageUsed.textContent = `${(bytes / 1048576).toFixed(2)} MB`;
  });
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
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

// --- Preview modal ---

const previewModal = document.getElementById('previewModal');
const previewTitle = document.getElementById('previewTitle');
const previewSubtitle = document.getElementById('previewSubtitle');
const previewBody = document.getElementById('previewBody');
const previewClose = document.getElementById('previewClose');

previewClose?.addEventListener('click', () => previewModal.classList.remove('visible'));
previewModal?.addEventListener('click', (e) => {
  if (e.target === previewModal) previewModal.classList.remove('visible');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewModal?.classList.contains('visible')) {
    previewModal.classList.remove('visible');
  }
});

function openPreviewModal(session) {
  previewTitle.textContent = session.name || 'Session Preview';
  const dom = session.events?.length || 0;
  const net = session.networkEvents?.length || 0;
  const fields = session.injectableFields?.length || 0;
  previewSubtitle.textContent = `${dom} DOM events · ${net} API calls · ${fields} injectable fields · ${session.startUrl || ''}`;

  // Merge dom + network events into a single timeline sorted by timestamp
  const timeline = [];
  (session.events || []).forEach(e => timeline.push({ kind: 'dom', ts: e.timestamp, event: e }));
  (session.networkEvents || []).forEach(n => timeline.push({ kind: 'net', ts: n.timestamp, event: n }));
  timeline.sort((a, b) => a.ts - b.ts);

  if (timeline.length === 0) {
    previewBody.innerHTML = '<div class="timeline-empty">No events captured in this session.</div>';
    previewModal.classList.add('visible');
    return;
  }

  const start = session.startTime || timeline[0].ts;
  const rows = timeline.map(t => renderTimelineRow(t, start)).join('');
  previewBody.innerHTML = rows;
  previewModal.classList.add('visible');
}

function renderTimelineRow(t, start) {
  const elapsed = formatElapsed(t.ts - start);
  if (t.kind === 'dom') {
    return renderDomRow(t.event, elapsed);
  }
  return renderNetRow(t.event, elapsed);
}

function renderDomRow(e, elapsed) {
  const icons = { click: '&#128073;', input: '&#9998;', paste: '&#128203;', navigation: '&#127760;', scroll: '&#8597;', focus: '&#128272;', blur: '&#128274;', keydown: '&#9000;' };
  const icon = icons[e.type] || '&#9679;';
  const el = e.element;
  let desc = '';
  let detail = '';

  if (e.type === 'click') {
    desc = el?.text ? `Click "${escapeHtml(truncate(el.text, 60))}"` :
           el?.ariaLabel ? `Click [${escapeHtml(el.ariaLabel)}]` :
           el?.id ? `Click #${escapeHtml(el.id)}` :
           `Click ${escapeHtml(el?.tag || 'element')}`;
    detail = el?.cssSelector ? escapeHtml(el.cssSelector) : '';
  } else if (e.type === 'input' || e.type === 'paste') {
    const field = el?.name || el?.id || el?.placeholder || 'field';
    const val = e.value === '[REDACTED]' ? '[REDACTED]' : truncate(e.value || '', 60);
    desc = `${e.type === 'paste' ? 'Paste' : 'Input'} into ${escapeHtml(field)}: "${escapeHtml(val)}"`;
    if (e.flag === 'INJECTABLE_POINT') {
      detail = `Injectable point — POST param: ${escapeHtml(el?.name || el?.id || '?')}`;
    }
  } else if (e.type === 'navigation') {
    desc = `Navigate to ${escapeHtml(e.url || '')}`;
  } else if (e.type === 'scroll') {
    desc = `Scroll to (${e.scrollX || 0}, ${e.scrollY || 0})`;
  } else if (e.type === 'focus' || e.type === 'blur') {
    desc = `${e.type === 'focus' ? 'Focus' : 'Blur'} ${escapeHtml(el?.name || el?.id || el?.tag || '')}`;
  } else if (e.type === 'keydown') {
    desc = `Key: ${escapeHtml(e.key || '')}`;
  } else {
    desc = escapeHtml(e.type);
  }

  return `
    <div class="timeline-row">
      <div class="timeline-time">${elapsed}</div>
      <div class="timeline-icon">${icon}</div>
      <div class="timeline-content">
        <span class="timeline-type ${escapeHtml(e.type)}">${escapeHtml(e.type)}</span>
        <span class="timeline-desc">${desc}</span>
        ${detail ? `<div class="timeline-detail">${detail}</div>` : ''}
      </div>
    </div>`;
}

function renderNetRow(n, elapsed) {
  let path = '';
  try { path = new URL(n.url).pathname; } catch { path = n.url || ''; }
  const status = n.responseStatus || '?';
  const statusColor = status >= 400 ? '#f87171' : status >= 300 ? '#fcd34d' : '#86efac';
  return `
    <div class="timeline-row">
      <div class="timeline-time">${elapsed}</div>
      <div class="timeline-icon">&#127760;</div>
      <div class="timeline-content">
        <span class="timeline-type network">${escapeHtml(n.method || '?')}</span>
        <span class="timeline-desc">${escapeHtml(path)}</span>
        <span style="color:${statusColor};margin-left:6px;font-weight:600">${status}</span>
        <div class="timeline-detail">${escapeHtml(truncate(n.url || '', 100))}</div>
      </div>
    </div>`;
}

function formatElapsed(ms) {
  if (!ms || ms < 0) return '0.0s';
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- Storage Debug Panel (v1.0.13 hotfix) ---
// Surfaces per-key chrome.storage.local usage so we can diagnose mismatches
// between "0 sessions" UI state and large reported storage usage. The 106 MB
// /0 sessions bug was an orphaned activeSession that never finalized.

const KNOWN_STORAGE_KEYS = [
  'completedSessions',
  'lastSession',
  'activeSession',
  'settings',
  'isRecording',
  'trackedTabIds',
  'activeTabId'
];

const debugPanel = document.getElementById('debugPanel');
const debugToggle = document.getElementById('debugToggle');
const debugKeyTable = document.getElementById('debugKeyTable');
const debugActiveSection = document.getElementById('debugActiveSection');
const debugActiveDetail = document.getElementById('debugActiveDetail');
const debugRefreshBtn = document.getElementById('debugRefreshBtn');
const debugListKeysBtn = document.getElementById('debugListKeysBtn');
const debugRecoverBtn = document.getElementById('debugRecoverBtn');
const debugClearActiveBtn = document.getElementById('debugClearActiveBtn');
const debugMigrateBtn = document.getElementById('debugMigrateBtn');
const debugMsg = document.getElementById('debugMsg');
const debugKeysList = document.getElementById('debugKeysList');

debugToggle?.addEventListener('click', () => {
  debugPanel.classList.toggle('expanded');
});

debugRefreshBtn?.addEventListener('click', () => refreshDebugPanel());
debugListKeysBtn?.addEventListener('click', () => listAllStorageKeys());
debugRecoverBtn?.addEventListener('click', () => recoverActiveSession());
debugClearActiveBtn?.addEventListener('click', () => clearActiveSession());
debugMigrateBtn?.addEventListener('click', () => migrateCompletedSessions());

function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

function getBytesInUse(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.getBytesInUse(key, (bytes) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(bytes);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function showDebugMsg(msg, isError) {
  if (!debugMsg) return;
  debugMsg.textContent = msg;
  debugMsg.classList.toggle('error', !!isError);
  debugMsg.classList.add('visible');
  setTimeout(() => debugMsg.classList.remove('visible'), 5000);
}

async function refreshDebugPanel() {
  try {
    const total = await getBytesInUse(null);
    const perKey = await Promise.all(
      KNOWN_STORAGE_KEYS.map(async (k) => ({ key: k, bytes: await getBytesInUse(k) }))
    );

    const accounted = perKey.reduce((s, r) => s + (r.bytes || 0), 0);
    const other = (total || 0) - accounted;

    const rows = [];
    rows.push(rowHtml('TOTAL', fmtBytes(total), total > 50 * 1048576 ? 'large' : ''));
    perKey.forEach(({ key, bytes }) => {
      const cls = bytes === 0 ? 'zero' : (bytes > 50 * 1048576 ? 'large' : '');
      rows.push(rowHtml(key, fmtBytes(bytes), cls));
    });
    if (other > 1024) {
      rows.push(rowHtml('(unaccounted)', fmtBytes(other), other > 50 * 1048576 ? 'large' : ''));
    }
    debugKeyTable.innerHTML = rows.join('');

    // Check activeSession content — show recovery UI if it has real data.
    let active = null;
    try {
      const stored = await chrome.storage.local.get('activeSession');
      active = stored.activeSession;
    } catch {}

    if (active) {
      const evCount = active.events?.length || 0;
      const netCount = active.networkEvents?.length || 0;
      const hasData = evCount > 0 || netCount > 0;
      debugActiveSection.style.display = 'block';
      debugActiveDetail.innerHTML = [
        rowHtml('name', escapeHtmlSafe(active.name || '(unnamed)')),
        rowHtml('startUrl', escapeHtmlSafe(active.startUrl || '(none)')),
        rowHtml('events.length', String(evCount)),
        rowHtml('networkEvents.length', String(netCount)),
        rowHtml('startTime', active.startTime ? new Date(active.startTime).toLocaleString() : '—'),
        rowHtml('endTime', active.endTime ? new Date(active.endTime).toLocaleString() : '(not set)')
      ].join('');
      debugRecoverBtn.style.display = hasData ? 'inline-block' : 'none';
      debugClearActiveBtn.style.display = 'inline-block';
      // Auto-show + auto-expand panel ONLY if there's an orphaned activeSession
      // with real data — that's the actual anomaly worth surfacing.
      if (hasData) {
        debugPanel.style.display = 'block';
        debugPanel.classList.add('expanded');
      } else {
        debugPanel.style.display = 'none';
      }
    } else {
      debugActiveSection.style.display = 'none';
      debugRecoverBtn.style.display = 'none';
      debugClearActiveBtn.style.display = 'none';
      // No orphan → keep debug panel hidden by default.
      debugPanel.style.display = 'none';
    }
  } catch (e) {
    console.error('[AgentScribe] debug panel refresh failed:', e);
    // Read failure IS an anomaly — surface the panel so user can act.
    debugPanel.style.display = 'block';
    debugPanel.classList.add('expanded');
    showDebugMsg(`Refresh failed: ${e.message || e}`, true);
  }
}

function rowHtml(k, v, vClass) {
  return `<div class="debug-row"><span class="k">${escapeHtmlSafe(k)}</span><span class="v ${vClass || ''}">${escapeHtmlSafe(v)}</span></div>`;
}

function escapeHtmlSafe(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function listAllStorageKeys() {
  try {
    const all = await chrome.storage.local.get(null);
    const entries = await Promise.all(
      Object.keys(all).map(async (k) => ({ key: k, bytes: await getBytesInUse(k) }))
    );
    entries.sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    const rows = entries.map(({ key, bytes }) => {
      const cls = bytes > 50 * 1048576 ? 'large' : (bytes === 0 ? 'zero' : '');
      return rowHtml(key, fmtBytes(bytes), cls);
    });
    debugKeysList.innerHTML = rows.join('') || '<div style="color:#666">(no keys)</div>';
    debugKeysList.style.display = 'block';
  } catch (e) {
    console.error('[AgentScribe] listAllStorageKeys failed:', e);
    showDebugMsg(`Failed: ${e.message || e}`, true);
  }
}

async function recoverActiveSession() {
  if (!confirm('Recover the orphaned activeSession into Completed Sessions?')) return;
  debugRecoverBtn.disabled = true;
  try {
    const result = await sendMessage({ type: 'RECOVER_ACTIVE_SESSION' });
    if (result?.success) {
      const s = result.session || {};
      const trunc = s.recoveredTruncatedCount ? ` (${s.recoveredTruncatedCount} oversized bodies truncated)` : '';
      showDebugMsg(`Recovered: "${s.name}" — ${s.domEventCount || 0} events / ${s.networkEventCount || 0} API calls${trunc}`, false);
      await renderSessions();
      await updateStorageUsage();
      await refreshDebugPanel();
    } else {
      showDebugMsg(`Recovery failed: ${result?.reason || result?.error || 'unknown'}`, true);
    }
  } catch (e) {
    showDebugMsg(`Recovery error: ${e.message || e}`, true);
  } finally {
    debugRecoverBtn.disabled = false;
  }
}

async function clearActiveSession() {
  if (!confirm('Discard the orphaned activeSession? This deletes its captured events permanently.')) return;
  debugClearActiveBtn.disabled = true;
  try {
    await chrome.storage.local.set({
      activeSession: null,
      isRecording: false,
      activeTabId: null,
      trackedTabIds: []
    });
    showDebugMsg('activeSession cleared. Storage should free up shortly.', false);
    await updateStorageUsage();
    await refreshDebugPanel();
  } catch (e) {
    showDebugMsg(`Clear failed: ${e.message || e}`, true);
  } finally {
    debugClearActiveBtn.disabled = false;
  }
}

// v1.0.14: migrate existing completedSessions through slimSessionForStorage.
// Pre-slim sessions (before the storage-slim wave) can be 50+ MB each. This
// button reslims them in-place via the background SW (which owns the slim
// function). Background reads its own storage — no IPC payload cap.
async function migrateCompletedSessions() {
  if (!confirm('Re-slim all completed sessions in storage? This compacts oversized fields (large response bodies, raw event data) using the current storage-slim rules. Safe — only trims fields that exceed caps.')) return;
  debugMigrateBtn.disabled = true;
  const originalText = debugMigrateBtn.textContent;
  debugMigrateBtn.textContent = 'Migrating…';
  try {
    const result = await sendMessage({ type: 'MIGRATE_COMPLETED_SESSIONS' });
    if (result?.success) {
      const beforeMB = (result.before / 1048576).toFixed(2);
      const afterMB = (result.after / 1048576).toFixed(2);
      const savedMB = ((result.before - result.after) / 1048576).toFixed(2);
      showDebugMsg(
        `Migrated ${result.sessionCount} session(s): ${beforeMB} MB → ${afterMB} MB (saved ${savedMB} MB)`,
        false
      );
      await renderSessions();
      await updateStorageUsage();
      await refreshDebugPanel();
    } else {
      showDebugMsg(`Migration failed: ${result?.reason || result?.error || 'unknown'}`, true);
    }
  } catch (e) {
    console.error('[AgentScribe] migrateCompletedSessions failed:', e);
    showDebugMsg(`Migration error: ${e.message || e}`, true);
  } finally {
    debugMigrateBtn.disabled = false;
    debugMigrateBtn.textContent = originalText;
  }
}

init();
