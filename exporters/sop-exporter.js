export function exportSOP(session) {
  const lines = [];
  const name = session.name || 'Untitled Session';
  const date = new Date(session.startTime).toLocaleString();
  const actionEvents = session.events.filter(e =>
    ['click', 'input', 'navigation', 'scroll', 'paste'].includes(e.type)
  );

  lines.push(`# Workflow SOP — ${name}`);
  lines.push(`**Recorded:** ${date} | **URL:** ${session.startUrl} | **Steps:** ${actionEvents.length} | **API Calls:** ${session.networkEvents.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  actionEvents.forEach((event, i) => {
    const step = i + 1;
    const elapsed = formatTime(event.timestamp - session.startTime);

    lines.push(`## Step ${step} — ${describeAction(event)} (${elapsed})`);
    lines.push('');

    if (event.type === 'navigation') {
      lines.push(`**Action:** Page loaded`);
      lines.push(`**URL:** ${event.url}`);
    } else if (event.type === 'click') {
      const desc = elementDescription(event.element);
      lines.push(`**Action:** Click on ${desc}`);
      if (event.element?.cssSelector) lines.push(`**Selector:** \`${escapeCode(event.element.cssSelector)}\``);
      if (event.element?.xpath) lines.push(`**XPath:** \`${escapeCode(event.element.xpath)}\``);
      if (event.triggeredRequests?.length) {
        event.triggeredRequests.forEach(req => {
          lines.push(`**API Triggered:** \`${escapeCode(req.method + ' ' + safePath(req.url))}\` → Status ${req.responseStatus}`);
          if (req.postData) {
            const payload = typeof req.postData === 'string'
              ? req.postData
              : JSON.stringify(req.postData);
            lines.push(`**Payload:** \`${escapeCode(truncate(payload, 200))}\``);
          }
        });
      }
    } else if (event.type === 'input' || event.type === 'paste') {
      const fieldName = event.element?.name || event.element?.id || event.element?.placeholder || 'field';
      lines.push(`**Action:** ${event.type === 'paste' ? 'Paste' : 'Type'} into \`${escapeCode(fieldName)}\``);
      if (event.element?.cssSelector) lines.push(`**Selector:** \`${escapeCode(event.element.cssSelector)}\``);
      if (event.value === '[REDACTED]') {
        lines.push(`**Value:** [REDACTED — sensitive field]`);
      } else if (event.value) {
        lines.push(`**Value:** \`${escapeCode(truncate(event.value, 100))}\``);
      }
      if (event.flag === 'INJECTABLE_POINT') {
        const param = event.element?.name || event.element?.id || '?';
        const action = event.element?.formAction || 'unknown';
        lines.push(`**Injectable point:** YES — POST param: \`${escapeCode(param)}\` → \`${escapeCode(action)}\``);
      }
    } else if (event.type === 'scroll') {
      lines.push(`**Action:** Scroll page`);
      lines.push(`**Position:** x:${event.scrollX || 0}, y:${event.scrollY || 0}`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  });

  if (session.injectableFields?.length) {
    lines.push('## Injectable Fields Summary');
    lines.push('');
    lines.push('| Field | Type | POST Param | Form Action | Sensitive |');
    lines.push('|---|---|---|---|---|');
    session.injectableFields.forEach(f => {
      const fieldName = escapeCode(f.name || f.id_attr || f.tag || '-').replace(/\|/g, '\\|');
      const param = escapeCode(f.postParamName || '-').replace(/\|/g, '\\|');
      const action = escapeCode(f.formAction || '-').replace(/\|/g, '\\|');
      lines.push(`| \`${fieldName}\` | ${f.type || '-'} | \`${param}\` | \`${action}\` | ${f.isSensitive ? 'YES' : 'no'} |`);
    });
    lines.push('');
  }

  if (session.networkEvents?.length) {
    const unique = new Set(session.networkEvents.map(n => `${n.method} ${safePath(n.url)}`));
    lines.push('## API Endpoints Discovered');
    lines.push('');
    unique.forEach(ep => lines.push(`- \`${escapeCode(ep)}\``));
    lines.push('');
  }

  const content = lines.join('\n');
  const blob = new Blob([content], { type: 'text/markdown' });
  const filename = `agentscribe-sop-${Date.now()}.md`;
  downloadBlob(blob, filename);
  return { filename, size: blob.size };
}

function describeAction(event) {
  if (event.type === 'navigation') return `Navigate to ${escapeMd(safePath(event.url))}`;
  if (event.type === 'click') return `Click ${elementDescription(event.element)}`;
  if (event.type === 'input') return `Input into ${escapeMd(event.element?.name || event.element?.id || 'field')}`;
  if (event.type === 'paste') return `Paste into ${escapeMd(event.element?.name || event.element?.id || 'field')}`;
  if (event.type === 'scroll') return `Scroll page`;
  return event.type;
}

function elementDescription(el) {
  if (!el) return 'element';
  if (el.text) return `\`${escapeCode(truncate(el.text, 40))}\``;
  if (el.ariaLabel) return `\`${escapeCode(el.ariaLabel)}\``;
  if (el.id) return `\`#${escapeCode(el.id)}\``;
  if (el.name) return `\`[name="${escapeCode(el.name)}"]\``;
  return `\`${escapeCode(el.tag || 'element')}\``;
}

// Escape only the actually-dangerous chars (backslash, backtick, asterisk,
// brackets, pipe). Underscore/paren/hash etc render fine inline.
function escapeMd(s) {
  if (s == null) return '';
  return String(s).replace(/([\\`*\[\]|])/g, '\\$1');
}

function escapeCode(s) {
  if (s == null) return '';
  // Inside backtick spans, the dangerous char is the backtick itself.
  // Replace ` with a Unicode lookalike (U+02CB) to avoid breaking the span.
  return String(s).replace(/`/g, 'ˋ');
}

function safePath(url) {
  try { return new URL(url).pathname; }
  catch { return url; }
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    URL.revokeObjectURL(url);
  });
}
