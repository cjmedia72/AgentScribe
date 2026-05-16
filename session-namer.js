// Session name: "{hostname} - {date, time}"

export function inferSessionName(session) {
  const host = getHostname(session.startUrl);
  const date = new Date(session.startTime).toLocaleString();
  return `${host} - ${date}`;
}

export function inferStartName(startUrl) {
  const host = getHostname(startUrl);
  const date = new Date().toLocaleString();
  return `${host} - ${date}`;
}

function getHostname(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') || u.host || 'page';
  } catch {
    return 'page';
  }
}
