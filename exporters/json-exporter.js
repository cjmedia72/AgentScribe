export function exportJSON(session) {
  return {
    content: JSON.stringify(session, null, 2),
    filename: `agentscribe-session-${Date.now()}.json`,
    mimeType: 'application/json'
  };
}
