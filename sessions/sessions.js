const sessionList = document.getElementById('sessionList');
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
      </div>
      <div class="session-actions">
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

  card.querySelector('.delete-btn').addEventListener('click', () => deleteSession(session.id));

  return card;
}

async function exportSession(sessionId, format, card) {
  const toast = card.querySelector('.toast');
  const buttons = card.querySelectorAll('.export-btn, .delete-btn');
  buttons.forEach(b => b.disabled = true);
  toast.textContent = `Generating ${format.toUpperCase()}...`;
  toast.classList.add('visible');

  const result = await sendMessage({ type: 'EXPORT', format, sessionId });

  if (result?.error) {
    toast.textContent = `Error: ${result.error}`;
    toast.style.color = '#f87171';
  } else if (result?.content && result?.filename) {
    triggerDownload(result.content, result.filename, result.mimeType);
    toast.textContent = `Downloaded: ${result.filename}`;
    toast.style.color = '#86efac';
  } else {
    toast.textContent = 'Export failed — no content returned';
    toast.style.color = '#f87171';
  }

  setTimeout(() => {
    toast.classList.remove('visible');
    toast.style.color = '';
    buttons.forEach(b => b.disabled = false);
  }, 2500);
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
