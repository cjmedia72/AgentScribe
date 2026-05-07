const OVERLAY_ID = 'agentscribe-overlay';
const TOOLTIP_ID = 'agentscribe-tooltip';
let eventCount = 0;
let startTime = 0;
let timerInterval = null;

function createOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.innerHTML = `
    <style>
      @keyframes agentscribe-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.4; }
      }
      #${OVERLAY_ID} {
        position: fixed !important;
        bottom: 16px !important;
        right: 16px !important;
        background: #1a1a1a !important;
        border: 1px solid #ef4444 !important;
        border-radius: 8px !important;
        padding: 8px 12px !important;
        font-family: 'SF Mono', 'Consolas', 'Monaco', monospace !important;
        font-size: 12px !important;
        color: #f8f8f8 !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        display: flex !important;
        align-items: center !important;
        gap: 8px !important;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5) !important;
        user-select: none !important;
      }
      #${OVERLAY_ID} .rec-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #ef4444;
        animation: agentscribe-pulse 1s infinite;
        flex-shrink: 0;
      }
      #${TOOLTIP_ID} {
        position: fixed !important;
        background: #1a1a1a !important;
        border: 1px solid #3b82f6 !important;
        border-radius: 6px !important;
        padding: 6px 10px !important;
        font-family: 'SF Mono', 'Consolas', 'Monaco', monospace !important;
        font-size: 11px !important;
        color: #93c5fd !important;
        z-index: 2147483647 !important;
        pointer-events: none !important;
        white-space: nowrap !important;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4) !important;
        max-width: 500px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }
    </style>
    <span class="rec-dot"></span>
    <span id="agentscribe-counter">REC — 0 events</span>
    <span id="agentscribe-timer" style="color:#888;margin-left:4px">0:00</span>
  `;
  document.documentElement.appendChild(overlay);
  startTime = Date.now();
  eventCount = 0;
  timerInterval = setInterval(updateTimer, 1000);
}

function updateTimer() {
  const el = document.getElementById('agentscribe-timer');
  if (!el) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = String(elapsed % 60).padStart(2, '0');
  el.textContent = `${mins}:${secs}`;
}

function updateOverlayCount(count) {
  eventCount = count;
  const el = document.getElementById('agentscribe-counter');
  if (el) el.textContent = `REC — ${count} events`;
}

function removeOverlay() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (overlay) overlay.remove();
  const tooltip = document.getElementById(TOOLTIP_ID);
  if (tooltip) tooltip.remove();
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function showFieldTooltip(el, fieldInfo) {
  let tooltip = document.getElementById(TOOLTIP_ID);
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = TOOLTIP_ID;
    document.documentElement.appendChild(tooltip);
  }

  const paramName = fieldInfo.postParamName || fieldInfo.name || fieldInfo.id_attr || '?';
  const action = fieldInfo.formAction || 'unknown';
  const method = fieldInfo.formMethod || 'POST';
  const sensitive = fieldInfo.isSensitive ? ' [SENSITIVE]' : '';

  tooltip.textContent = `INJECTABLE: ${method} param "${paramName}" → ${action}${sensitive}`;

  const rect = el.getBoundingClientRect();
  tooltip.style.left = `${rect.left}px`;
  tooltip.style.top = `${Math.max(0, rect.top - 32)}px`;
  tooltip.style.display = 'block';
}

function hideFieldTooltip() {
  const tooltip = document.getElementById(TOOLTIP_ID);
  if (tooltip) tooltip.style.display = 'none';
}

if (typeof window !== 'undefined') {
  window.__agentscribe = window.__agentscribe || {};
  window.__agentscribe.createOverlay = createOverlay;
  window.__agentscribe.removeOverlay = removeOverlay;
  window.__agentscribe.updateOverlayCount = updateOverlayCount;
  window.__agentscribe.showFieldTooltip = showFieldTooltip;
  window.__agentscribe.hideFieldTooltip = hideFieldTooltip;
}
