export function exportPostman(session) {
  const endpoints = deduplicateEndpoints(session.networkEvents);
  const grouped = groupByDomain(endpoints);

  const collection = {
    info: {
      name: `AgentScribe — ${session.name || session.startUrl}`,
      description: `Recorded ${new Date(session.startTime).toISOString()} | ${session.networkEvents.length} API calls captured`,
      schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
    },
    item: grouped.map(group => ({
      name: group.domain,
      item: group.requests.map(req => ({
        name: `${req.method} ${safePath(req.url)}`,
        request: {
          method: req.method,
          header: Object.entries(req.headers || {})
            .filter(([k]) => !k.toLowerCase().startsWith(':'))
            .map(([key, value]) => ({ key, value: String(value) })),
          url: parsePostmanUrl(req.url),
          ...(req.postData ? {
            body: {
              mode: 'raw',
              raw: typeof req.postData === 'string' ? req.postData : JSON.stringify(req.postData, null, 2),
              options: { raw: { language: 'json' } }
            }
          } : {})
        },
        response: [{
          name: 'Captured Response',
          originalRequest: {
            method: req.method,
            url: parsePostmanUrl(req.url)
          },
          status: statusText(req.responseStatus),
          code: req.responseStatus,
          body: req.responseBody || ''
        }]
      }))
    }))
  };

  const content = JSON.stringify(collection, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const filename = `agentscribe-postman-${Date.now()}.json`;
  downloadBlob(blob, filename);
  return { filename, size: blob.size };
}

function deduplicateEndpoints(networkEvents) {
  const seen = new Map();
  const results = [];
  for (const evt of networkEvents) {
    if (evt.isAnalytics) continue;
    const key = `${evt.method}|${evt.url}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      results.push(evt);
    }
  }
  return results;
}

function groupByDomain(endpoints) {
  const groups = new Map();
  for (const req of endpoints) {
    let domain;
    try { domain = new URL(req.url).hostname; }
    catch { domain = 'unknown'; }
    if (!groups.has(domain)) groups.set(domain, []);
    groups.get(domain).push(req);
  }
  return Array.from(groups.entries()).map(([domain, requests]) => ({ domain, requests }));
}

function parsePostmanUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return {
      raw: rawUrl,
      protocol: u.protocol.replace(':', ''),
      host: u.hostname.split('.'),
      port: u.port || undefined,
      path: u.pathname.split('/').filter(Boolean),
      query: Array.from(u.searchParams.entries()).map(([key, value]) => ({ key, value }))
    };
  } catch {
    return { raw: rawUrl };
  }
}

function safePath(url) {
  try { return new URL(url).pathname; }
  catch { return url; }
}

function statusText(code) {
  const map = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Server Error' };
  return map[code] || String(code);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    URL.revokeObjectURL(url);
  });
}
