const DEFAULT_SETTINGS = {
  maxEvents: null,
  sessionNamePrefix: 'AgentScribe Session',
  captureScrolls: true,
  captureFocusBlur: true,
  logSensitiveValues: false,
  networkMethod: 'cdp',
  mcpExportEnabled: false,
  correlationWindowMs: 1000,
  analyticsFilterDomains: [
    'google-analytics.com',
    'doubleclick.net',
    'facebook.com/tr',
    'amazon-adsystem.com',
    'quantummetric.com',
    'fullstory.com'
  ],
  autoExportOnCap: false
};

const fields = {
  sessionNamePrefix: document.getElementById('sessionNamePrefix'),
  maxEvents: document.getElementById('maxEvents'),
  autoExportOnCap: document.getElementById('autoExportOnCap'),
  captureScrolls: document.getElementById('captureScrolls'),
  captureFocusBlur: document.getElementById('captureFocusBlur'),
  logSensitiveValues: document.getElementById('logSensitiveValues'),
  networkMethod: document.getElementById('networkMethod'),
  mcpExportEnabled: document.getElementById('mcpExportEnabled'),
  correlationWindowMs: document.getElementById('correlationWindowMs'),
  analyticsFilterDomains: document.getElementById('analyticsFilterDomains')
};

const storageUsed = document.getElementById('storageUsed');
const btnSave = document.getElementById('btnSave');
const btnClearSessions = document.getElementById('btnClearSessions');
const btnExportAll = document.getElementById('btnExportAll');
const btnViewSessions = document.getElementById('btnViewSessions');
const saveStatus = document.getElementById('saveStatus');

async function loadSettings() {
  const data = await chrome.storage.local.get('settings');
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };

  fields.sessionNamePrefix.value = settings.sessionNamePrefix;
  fields.maxEvents.value = settings.maxEvents || '';
  fields.autoExportOnCap.checked = settings.autoExportOnCap;
  fields.captureScrolls.checked = settings.captureScrolls;
  fields.captureFocusBlur.checked = settings.captureFocusBlur;
  fields.logSensitiveValues.checked = settings.logSensitiveValues;
  fields.networkMethod.value = settings.networkMethod;
  fields.mcpExportEnabled.checked = settings.mcpExportEnabled;
  fields.correlationWindowMs.value = settings.correlationWindowMs;
  fields.analyticsFilterDomains.value = (settings.analyticsFilterDomains || []).join('\n');

  updateStorageUsage();
}

function gatherSettings() {
  const maxEventsVal = fields.maxEvents.value.trim();
  return {
    sessionNamePrefix: fields.sessionNamePrefix.value.trim() || DEFAULT_SETTINGS.sessionNamePrefix,
    maxEvents: maxEventsVal ? parseInt(maxEventsVal, 10) : null,
    autoExportOnCap: fields.autoExportOnCap.checked,
    captureScrolls: fields.captureScrolls.checked,
    captureFocusBlur: fields.captureFocusBlur.checked,
    logSensitiveValues: fields.logSensitiveValues.checked,
    networkMethod: fields.networkMethod.value,
    mcpExportEnabled: fields.mcpExportEnabled.checked,
    correlationWindowMs: parseInt(fields.correlationWindowMs.value, 10) || 1000,
    analyticsFilterDomains: fields.analyticsFilterDomains.value
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
  };
}

btnSave.addEventListener('click', async () => {
  const settings = gatherSettings();
  await chrome.storage.local.set({ settings });
  saveStatus.classList.add('visible');
  setTimeout(() => saveStatus.classList.remove('visible'), 2000);
});

btnClearSessions.addEventListener('click', async () => {
  if (!confirm('Delete ALL saved sessions? This cannot be undone.')) return;
  await chrome.storage.local.remove(['completedSessions', 'lastSession', 'activeSession']);
  updateStorageUsage();
  saveStatus.textContent = 'Sessions cleared';
  saveStatus.classList.add('visible');
  setTimeout(() => {
    saveStatus.textContent = 'Settings saved';
    saveStatus.classList.remove('visible');
  }, 2000);
});

btnViewSessions.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('sessions/sessions.html') });
});

btnExportAll.addEventListener('click', async () => {
  const data = await chrome.storage.local.get('completedSessions');
  const sessions = data.completedSessions || [];
  if (sessions.length === 0) {
    alert('No saved sessions to export.');
    return;
  }
  const blob = new Blob(
    [JSON.stringify(sessions, null, 2)],
    { type: 'application/json' }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `agentscribe-all-sessions-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

async function updateStorageUsage() {
  chrome.storage.local.getBytesInUse(null, (bytes) => {
    if (bytes < 1024) {
      storageUsed.textContent = `${bytes} B`;
    } else if (bytes < 1048576) {
      storageUsed.textContent = `${(bytes / 1024).toFixed(1)} KB`;
    } else {
      storageUsed.textContent = `${(bytes / 1048576).toFixed(2)} MB`;
    }
  });
}

loadSettings();
