export function exportJSON(session) {
  const blob = new Blob(
    [JSON.stringify(session, null, 2)],
    { type: 'application/json' }
  );
  const filename = `agentscribe-session-${Date.now()}.json`;
  downloadBlob(blob, filename);
  return { filename, size: blob.size };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    URL.revokeObjectURL(url);
  });
}
