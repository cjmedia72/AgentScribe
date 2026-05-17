import { exportJSON } from '../exporters/json-exporter.js';
import { exportPlaywright } from '../exporters/playwright-exporter.js';
import { exportPostman } from '../exporters/postman-exporter.js';
import { exportSOP } from '../exporters/sop-exporter.js';
import { exportMCP } from '../exporters/mcp-exporter.js';
import { exportBundle, exportBundleLean, buildShimText } from '../exporters/bundle-exporter.js';

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
}

async function renderSessions() {
  const sessions = await sendMessage({ type: 'GET_COMPLETED_SESSIONS' }) || [];

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

  return card;
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
    // Build shim synchronously
    const full = exportBundle(session);
    const subpath = `AgentScribe/sessions/${full.filename}`;
    const paths = {
      subpath,
      windows: `%USERPROFILE%\\Downloads\\${subpath.replace(/\//g, '\\')}`,
      posix: `~/Downloads/${subpath}`
    };
    const shim = buildShimText(session, paths);

    // FIRST await is the clipboard write — activation still valid
    await navigator.clipboard.writeText(shim);

    toast.textContent = `Shim copied (${(shim.length/1024).toFixed(1)} KB). Saving file...`;
    toast.style.color = '#86efac';

    // Now save file (no longer competing for activation)
    const blob = new Blob([full.content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: subpath, saveAs: false }, () => {
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast.textContent = `Shim copied + file saved. Paste into your agent.`;
    });
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
  await sendMessage({ type: 'DELETE_SESSION', sessionId });
  await renderSessions();
  await updateStorageUsage();
}

clearAllBtn.addEventListener('click', async () => {
  if (!confirm('Delete ALL saved sessions? This cannot be undone.')) return;
  await sendMessage({ type: 'CLEAR_SESSIONS' });
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

init();
