export function exportMCP(session) {
  const output = {
    type: 'workflow_recording',
    schema_version: '1.0',
    session_id: session.id,
    recorded_at: session.startTime,
    start_url: session.startUrl,
    summary: {
      total_steps: session.events.filter(e => e.type !== 'scroll').length,
      api_endpoints_discovered: uniqueEndpoints(session.networkEvents),
      injectable_fields: session.injectableFields?.length || 0,
      pages_visited: [...new Set(session.events.map(e => e.url).filter(Boolean))]
    },
    steps: session.events
      .filter(e => ['click', 'input', 'navigation', 'paste'].includes(e.type))
      .map((e, i) => ({
        step: i + 1,
        action: e.type,
        description: describeEvent(e),
        selector: e.element?.cssSelector || null,
        xpath: e.element?.xpath || null,
        value: e.value || null,
        url: e.url,
        api_calls: (e.triggeredRequests || []).map(r => ({
          method: r.method,
          url: r.url,
          payload: r.postData || r.postDataParsed || null,
          status: r.responseStatus,
          is_primary: r.isPrimary
        }))
      })),
    api_map: session.networkEvents
      .filter(n => !isAnalytics(n))
      .map(n => ({
        endpoint: `${n.method} ${n.url}`,
        method: n.method,
        url: n.url,
        payload_schema: inferSchema(n.postDataParsed),
        response_status: n.responseStatus,
        triggered_by_step: n.correlatedToDomEventId
      })),
    injectable_fields: (session.injectableFields || []).map(f => ({
      field_name: f.name || f.id_attr,
      selector: f.cssSelector,
      xpath: f.xpath,
      post_param: f.postParamName,
      form_action: f.formAction,
      form_method: f.formMethod,
      purpose: f.purposeInferred,
      is_sensitive: f.isSensitive
    }))
  };

  const content = JSON.stringify(output, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const filename = `agentscribe-mcp-${Date.now()}.json`;
  downloadBlob(blob, filename);
  return { filename, size: blob.size };
}

function describeEvent(e) {
  if (e.type === 'navigation') return `Navigate to ${e.url}`;
  if (e.type === 'click') {
    const target = e.element?.text || e.element?.ariaLabel || e.element?.id || e.element?.tag || 'element';
    return `Click on ${target}`;
  }
  if (e.type === 'input' || e.type === 'paste') {
    const field = e.element?.name || e.element?.id || e.element?.placeholder || 'field';
    return `${e.type === 'paste' ? 'Paste' : 'Type'} into ${field}`;
  }
  return e.type;
}

function inferSchema(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const schema = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) schema[key] = 'null';
    else if (Array.isArray(value)) schema[key] = 'array';
    else schema[key] = typeof value;
  }
  return schema;
}

function uniqueEndpoints(networkEvents) {
  const set = new Set();
  for (const n of networkEvents) {
    if (!isAnalytics(n)) {
      try { set.add(`${n.method} ${new URL(n.url).pathname}`); }
      catch { set.add(`${n.method} ${n.url}`); }
    }
  }
  return [...set];
}

function isAnalytics(n) {
  const domains = ['analytics', 'metrics', 'telemetry', 'beacon', 'segment.io', 'mixpanel', 'hotjar', 'fullstory', 'quantummetric'];
  return domains.some(d => (n.url || '').toLowerCase().includes(d));
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    URL.revokeObjectURL(url);
  });
}
