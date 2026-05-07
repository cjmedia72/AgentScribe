const CORRELATION_WINDOW_MS = 1000;

const ANALYTICS_DOMAINS = [
  'analytics', 'metrics', 'telemetry', 'beacon',
  'segment.io', 'mixpanel', 'hotjar', 'fullstory',
  'quantummetric', 'rum.amazonaws.com'
];

export function correlate(domEvents, networkEvents, windowMs) {
  const window_ = windowMs || CORRELATION_WINDOW_MS;
  const correlated = [...networkEvents];

  correlated.forEach(netEvent => {
    const windowStart = netEvent.timestamp - window_;
    const candidates = domEvents.filter(
      d => d.timestamp >= windowStart && d.timestamp <= netEvent.timestamp
    );

    const trigger = candidates[candidates.length - 1] || null;

    if (trigger) {
      netEvent.correlatedToDomEventId = trigger.id;
      if (!trigger.triggeredRequests) trigger.triggeredRequests = [];
      trigger.triggeredRequests.push({
        requestId: netEvent.requestId,
        url: netEvent.url,
        method: netEvent.method,
        postData: netEvent.postData,
        postDataParsed: netEvent.postDataParsed,
        responseStatus: netEvent.responseStatus,
        isPrimary: isPrimaryRequest(netEvent),
        isAnalytics: isAnalyticsRequest(netEvent)
      });
    } else {
      netEvent.correlatedToDomEventId = null;
      netEvent.isBackgroundRequest = true;
    }
  });

  return { domEvents, networkEvents: correlated };
}

function isPrimaryRequest(netEvent) {
  return !isAnalyticsRequest(netEvent) &&
    ['XHR', 'Fetch'].includes(netEvent.resourceType) &&
    ['POST', 'PUT', 'DELETE', 'GET'].includes(netEvent.method);
}

function isAnalyticsRequest(netEvent) {
  return ANALYTICS_DOMAINS.some(d => netEvent.url.toLowerCase().includes(d));
}
