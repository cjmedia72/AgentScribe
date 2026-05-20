import { exportPlaywright } from './playwright-exporter.js';
import { exportPostman } from './postman-exporter.js';
import { exportSOP } from './sop-exporter.js';
import { exportMCP } from './mcp-exporter.js';

// Full bundle — all 5 formats embedded. Used for file download.
export function exportBundle(session) {
  let playwrightContent = null;
  let postmanObject = null;
  let postmanEnvironment = null;
  let sopContent = null;
  let mcpObject = null;

  try { playwrightContent = exportPlaywright(session).content; }
  catch (e) { playwrightContent = `// playwright export failed: ${e.message}`; }

  try {
    const postmanResult = exportPostman(session);
    postmanObject = JSON.parse(postmanResult.content);
    // v1.0.13 — postman exporter now returns { content, filename, mimeType, environmentFile? }
    if (postmanResult.environmentFile) {
      try {
        postmanEnvironment = typeof postmanResult.environmentFile === 'string'
          ? JSON.parse(postmanResult.environmentFile)
          : postmanResult.environmentFile;
      } catch (envErr) {
        postmanEnvironment = { error: `postman environment parse failed: ${envErr.message}` };
      }
    }
  } catch (e) {
    postmanObject = { error: `postman export failed: ${e.message}` };
  }

  try { sopContent = exportSOP(session).content; }
  catch (e) { sopContent = `# SOP export failed: ${e.message}`; }

  try { mcpObject = JSON.parse(exportMCP(session).content); }
  catch (e) { mcpObject = { error: `mcp export failed: ${e.message}` }; }

  // v1.0.13 — synthesize replay_hints from session-level signals (defensive)
  const replayHints = buildReplayHints(session);

  // Parse playwright storageState back out of generated script (defensive — best effort)
  const playwrightStorageState = extractPlaywrightStorageState(playwrightContent);

  const bundle = {
    _meta: buildMeta(session, 'full'),
    raw_session: session,
    playwright_script: playwrightContent,
    postman_collection: postmanObject,
    sop_markdown: sopContent,
    mcp_output: mcpObject,
    // v1.0.12 export-format index (kept for agents that look here)
    exports: {
      json: 'raw_session',
      playwright: {
        script: playwrightContent,
        storageState: playwrightStorageState
      },
      postman: {
        collection: postmanObject,
        environment: postmanEnvironment
      },
      sop: sopContent,
      mcp: mcpObject
    },
    // v1.0.13 — top-level convenience surfacing of new session fields
    auth_profile: session?.authProfile || null,
    cookie_snapshots: Array.isArray(session?.cookieSnapshots) ? session.cookieSnapshots : [],
    storage_snapshots: Array.isArray(session?.storageSnapshots) ? session.storageSnapshots : [],
    bundle_findings: Array.isArray(session?.bundleFindings) ? session.bundleFindings : [],
    ws_connections: Array.isArray(session?.wsConnections) ? session.wsConnections : [],
    ws_frames: Array.isArray(session?.wsFrames) ? session.wsFrames : [],
    challenge_layer: session?.challengeLayer || null,
    replay_hints: replayHints
  };

  // Cross-export consistency check — sanity validate the parallel representations
  const warnings = runConsistencyChecks({
    session,
    playwrightStorageState,
    postmanEnvironment,
    mcpObject
  });
  if (warnings.length > 0) {
    bundle._meta.consistency_warnings = warnings;
  }

  return {
    content: JSON.stringify(bundle, null, 2),
    filename: filenameFor(session, 'full'),
    mimeType: 'application/json'
  };
}

// Lean bundle — strips raw_session, response bodies, and the playwright/postman/sop
// duplicates. Just the MCP map (which is the actionable bit for an agent) plus
// injectable fields and meta. Targets <50KB for typical sessions so it doesn't
// crash Claude Desktop / OpenAI when pasted.
export function exportBundleLean(session) {
  let mcpObject = null;
  try { mcpObject = JSON.parse(exportMCP(session).content); }
  catch (e) { mcpObject = { error: `mcp export failed: ${e.message}` }; }

  // Trim heavy bits from MCP api_map
  if (mcpObject?.api_map) {
    mcpObject.api_map = mcpObject.api_map.map(a => ({
      method: a.method,
      url: a.url,
      payload_schema: a.payload_schema,
      response_status: a.response_status,
      triggered_by_step: a.triggered_by_step
    }));
  }

  // Trim steps — drop verbose selector dupes but keep enough for replay
  if (mcpObject?.steps) {
    mcpObject.steps = mcpObject.steps.map(s => ({
      step: s.step,
      action: s.action,
      description: s.description,
      selector: s.selector,
      value: s.value,
      url: s.url,
      api_calls: (s.api_calls || []).map(c => ({
        method: c.method,
        url: c.url,
        status: c.status,
        is_primary: c.is_primary
      }))
    }));
  }

  // v1.0.13 — auth profile summary (stripped — NO raw cookies/storage in lean)
  const authProfile = session?.authProfile || null;
  const hasAuthState = !!(
    authProfile ||
    (Array.isArray(session?.cookieSnapshots) && session.cookieSnapshots.length > 0) ||
    (Array.isArray(session?.storageSnapshots) && session.storageSnapshots.length > 0)
  );

  const authProfileSummary = authProfile ? {
    scheme: authProfile.auth_scheme || null,
    auth_value_source: authProfile.auth_value_source || null,
    expires_at: authProfile.expires_at || null,
    has_csrf: !!authProfile.has_csrf || hasCsrfField(session),
    challenge_layer: session?.challengeLayer || null
  } : null;

  const meta = buildMeta(session, 'lean');
  meta.has_auth_state = hasAuthState;

  const lean = {
    _meta: meta,
    mcp: mcpObject,
    injectable_fields: (session.injectableFields || []).map(f => ({
      field_name: f.name || f.id_attr,
      selector: f.cssSelector,
      xpath: f.xpath,
      post_param: f.postParamName,
      form_action: f.formAction,
      form_method: f.formMethod,
      purpose: f.purposeInferred,
      is_sensitive: f.isSensitive,
      field_kind: f.field_kind || null
    })),
    auth_profile_summary: authProfileSummary,
    replay_hints: buildReplayHints(session)
  };

  return {
    content: JSON.stringify(lean, null, 2),
    filename: filenameFor(session, 'lean'),
    mimeType: 'application/json'
  };
}

// Shim text — ~2KB clipboard payload pointing the receiving agent to the
// full bundle file on disk. Use when the agent has filesystem access
// (Claude Code, Claude Desktop with Filesystem MCP, Cursor, etc.).
// `paths` is either a string (legacy single absolute path) or an object
// { subpath, windows, posix } so the agent can resolve on any OS.
export function buildShimText(session, paths) {
  const dur = Math.round(((session.endTime || Date.now()) - session.startTime) / 1000);
  const stats = `${session.events?.length || 0} DOM events · ${session.networkEvents?.length || 0} API calls · ${session.injectableFields?.length || 0} injectable fields`;

  let pathBlock;
  if (typeof paths === 'string') {
    pathBlock = `## Full bundle file (on this machine):\n${paths}`;
  } else {
    pathBlock = `## Full bundle file (saved to your Downloads folder):

Relative path: \`${paths.subpath}\`

OS-specific absolute paths:
- Windows: \`${paths.windows}\`
- Mac / Linux: \`${paths.posix}\``;
  }

  return `# AgentScribe Session Handoff

Session: ${session.name}
URL: ${session.startUrl}
Recorded: ${new Date(session.startTime).toLocaleString()}
Duration: ${dur}s
Stats: ${stats}

${pathBlock}

The full bundle — raw session events, every captured API call with payloads and response bodies, plus all 5 export formats (Raw JSON, Playwright, Postman, SOP, MCP) — is saved at the path above.

## For the receiving agent:

If you have filesystem access (Claude Code, Claude Desktop with Filesystem MCP, Cursor, etc.):
- READ the file at the path above directly.
- Do NOT ask the user to paste the contents — the file exists, just read it.

If you don't have filesystem access:
- Ask the user to download a different format (Raw JSON, Playwright, etc.) and paste it.

## What's in the bundle:
- \`_meta\` — session info, stats, agent usage notes
- \`raw_session\` — every DOM event + every network call with payloads + response bodies
- \`mcp_output.api_map\` — the actionable list of API endpoints the user's actions fired (start here for automation)
- \`mcp_output.steps\` — the user's action sequence
- \`raw_session.injectableFields\` — form fields mapped to POST param names (use for parameterizing the workflow over a list of inputs)
- \`auth_profile\` / \`cookie_snapshots\` / \`storage_snapshots\` — captured session state for replay
- \`replay_hints\` — quick flags: OTP at replay, CSRF refresh, token expiry, challenge layer
- \`playwright_script\` — runnable JS for browser-based replay (storageState pre-injected)
- \`postman_collection\` — importable into Postman directly (companion environment in \`exports.postman.environment\`)
- \`sop_markdown\` — human-readable workflow walkthrough

## To automate this workflow at scale:
1. READ the file above to get the full bundle.
2. Check \`replay_hints\` — if \`requires_otp_at_replay\` or \`requires_csrf_refresh\` is true, plan accordingly.
3. Use \`mcp_output.api_map\` to identify the highest-leverage endpoint (typically a POST/PUT/DELETE matching the user's intent).
4. Use \`raw_session.injectableFields\` to know which inputs to parameterize.
5. Generate a script that loops over the user's target inputs and hits those APIs directly — bypass the UI entirely.
`;
}

// Wrap the lean bundle JSON in agent-friendly instructions for clipboard paste.
// Self-contained — no file dependency. Total payload ~22KB for typical sessions.
export function wrapLeanForClipboard(session, leanJsonString) {
  const dur = Math.round(((session.endTime || Date.now()) - session.startTime) / 1000);
  const dom = session.events?.length || 0;
  const net = session.networkEvents?.length || 0;
  const fields = session.injectableFields?.length || 0;
  return `# AgentScribe Session Handoff

Session: ${session.name}
URL: ${session.startUrl}
Recorded: ${new Date(session.startTime).toLocaleString()}
Duration: ${dur}s
Stats: ${dom} DOM events · ${net} API calls · ${fields} injectable fields

## Agent instructions:

This is a self-contained recording of a browser workflow. The JSON below contains everything you need to automate this workflow at scale.

**Start here:** \`mcp.api_map\` lists the actual API endpoints the user's clicks fired (method + URL + payload schema + response status). To bypass the UI entirely, generate a script that hits those endpoints directly.

**Auth state:** Check \`_meta.has_auth_state\` and \`auth_profile_summary\` to know what auth scheme is in play and whether the session carries CSRF / challenge-layer signals. Full cookies / storage are NOT in the lean export — use the BUNDLE button if you need them.

**Replay hints:** \`replay_hints\` flags whether OTP input or CSRF refresh is required at replay time, and when the captured token expires.

**To parameterize:** \`injectable_fields\` maps form fields to POST param names. Loop your script over a list of target inputs, varying these fields.

**For the action sequence (if browser-based replay is required):** \`mcp.steps\` is the chronological list of user actions with selectors.

**Note:** This is a LEAN export — raw event log, response bodies, cookie/storage snapshots, and Playwright/Postman/SOP formats are not included to keep clipboard size manageable. If you need any of those, ask the user to click the BUNDLE button in the AgentScribe extension to download the full bundle.

## Session data:

\`\`\`json
${leanJsonString}
\`\`\`
`;
}

function buildMeta(session, variant) {
  return {
    schema: variant === 'lean' ? 'agentscribe-bundle-lean' : 'agentscribe-bundle',
    schema_version: '1.0.13',
    session_id: session.id,
    session_name: session.name,
    start_url: session.startUrl,
    recorded_at: session.startTime,
    ended_at: session.endTime,
    duration_ms: (session.endTime || Date.now()) - session.startTime,
    exported_at: Date.now(),
    stats: {
      dom_events: session.events?.length || 0,
      network_events: session.networkEvents?.length || 0,
      injectable_fields: session.injectableFields?.length || 0,
      api_endpoints: session.apiEndpoints?.length || 0,
      dropped_events: session.droppedEvents || 0,
      // v1.0.13 — new capture surfaces
      cookie_snapshots: Array.isArray(session.cookieSnapshots) ? session.cookieSnapshots.length : 0,
      storage_snapshots: Array.isArray(session.storageSnapshots) ? session.storageSnapshots.length : 0,
      bundle_findings: Array.isArray(session.bundleFindings) ? session.bundleFindings.length : 0,
      ws_connections: Array.isArray(session.wsConnections) ? session.wsConnections.length : 0,
      ws_frames: Array.isArray(session.wsFrames) ? session.wsFrames.length : 0
    },
    instructions_for_agent: variant === 'lean' ? [
      'Lean bundle for direct paste into an agent — optimized for context-window efficiency.',
      'Use `mcp.api_map` to call the recorded APIs directly (this is the highest-leverage data).',
      'Use `mcp.steps` for the action sequence and `injectable_fields` to parameterize over inputs.',
      'Check `_meta.has_auth_state` + `auth_profile_summary` + `replay_hints` for auth/replay constraints.',
      'For full fidelity (raw events, response bodies, cookie/storage snapshots, playwright/postman/sop), use the BUNDLE button instead of clipboard.'
    ] : [
      'Full bundle — one workflow recording in 5 representations + captured session state.',
      '`mcp_output.api_map` lists the actual API endpoints the user\'s clicks fired, with payloads.',
      '`mcp_output.steps` is the action sequence.',
      '`exports.playwright.script` is runnable replay code with `exports.playwright.storageState` pre-injected.',
      '`exports.postman.collection` imports into Postman directly; `exports.postman.environment` carries the auth vars.',
      '`exports.sop` is a readable walkthrough for humans.',
      '`raw_session` has every captured DOM and network event for forensic analysis.',
      '`auth_profile`, `cookie_snapshots`, `storage_snapshots` carry the captured session state for replay.',
      '`replay_hints` flags OTP / CSRF / expiry / challenge-layer constraints at a glance.',
      'Sensitive field values appear as [REDACTED] — substitute real values before replaying.',
      '`raw_session.injectableFields` maps form fields to POST param names for parameterizing the workflow.'
    ]
  };
}

function filenameFor(session, variant) {
  const safe = sanitizeForFilename(session.name || 'session');
  return variant === 'lean'
    ? `agentscribe-bundle-${safe}.lean.json`
    : `agentscribe-bundle-${safe}.json`;
}

function sanitizeForFilename(s) {
  if (!s) return 'session';
  return String(s)
    .replace(/[\/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120)
    .replace(/^_+|_+$/g, '');
}

// ------------------------------------------------------------------
// v1.0.13 helpers
// ------------------------------------------------------------------

// Detect if any injectable field is an OTP field (drives requires_otp_at_replay).
function hasOtpField(session) {
  const fields = session?.injectableFields;
  if (!Array.isArray(fields)) return false;
  return fields.some(f => f && f.field_kind === 'otp');
}

// Detect if a CSRF field was captured (drives requires_csrf_refresh + has_csrf summary).
function hasCsrfField(session) {
  const fields = session?.injectableFields;
  if (!Array.isArray(fields)) return false;
  return fields.some(f => f && f.field_kind === 'csrf');
}

// Synthesize replay_hints — defensive, all fields fall back to safe defaults.
function buildReplayHints(session) {
  const authProfile = session?.authProfile || null;
  return {
    requires_otp_at_replay: hasOtpField(session),
    requires_csrf_refresh: hasCsrfField(session),
    token_expires_at: authProfile?.expires_at || null,
    challenge_layer: session?.challengeLayer || null
  };
}

// Best-effort extraction of storageState from the generated Playwright script.
// The script embeds `storageState: { ... }` as a JS object literal inside the
// `chromium.launchPersistentContext` / `newContext` call. We parse it back out
// so agents can read it without having to eval the script.
function extractPlaywrightStorageState(script) {
  if (typeof script !== 'string') return null;
  // Match `storageState: { ... }` — find the opening brace then balance braces.
  const idx = script.indexOf('storageState:');
  if (idx === -1) return null;
  const braceStart = script.indexOf('{', idx);
  if (braceStart === -1) return null;
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < script.length; i++) {
    const ch = script[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;
  const literal = script.slice(braceStart, end + 1);
  try {
    return JSON.parse(literal);
  } catch {
    return null;
  }
}

// Cross-export consistency check. Returns an array of warning strings (empty = OK).
function runConsistencyChecks({ session, playwrightStorageState, postmanEnvironment, mcpObject }) {
  const warnings = [];

  // 1. Playwright cookie count vs last cookieSnapshot count
  try {
    const pwCookies = playwrightStorageState?.cookies;
    const snapshots = session?.cookieSnapshots;
    if (Array.isArray(pwCookies) && Array.isArray(snapshots) && snapshots.length > 0) {
      const last = snapshots[snapshots.length - 1];
      const lastCookies = Array.isArray(last?.cookies) ? last.cookies : [];
      if (pwCookies.length !== lastCookies.length) {
        warnings.push(
          `playwright.storageState.cookies (${pwCookies.length}) does not match ` +
          `cookieSnapshots[last].cookies (${lastCookies.length})`
        );
      }
    }
  } catch (e) {
    warnings.push(`cookie-count consistency check failed: ${e.message}`);
  }

  // 2. Postman auth_token var vs MCP auth_state.auth_value_source
  try {
    const envValues = Array.isArray(postmanEnvironment?.values) ? postmanEnvironment.values : [];
    const hasAuthTokenVar = envValues.some(v => v && v.key === 'auth_token');
    const mcpAuthSource = mcpObject?.auth_state?.auth_value_source || null;
    if (hasAuthTokenVar && !mcpAuthSource) {
      warnings.push(
        'postman environment defines `auth_token` but MCP auth_state.auth_value_source is null — ' +
        'agents may not know how to substitute the token'
      );
    }
  } catch (e) {
    warnings.push(`postman/mcp auth-source consistency check failed: ${e.message}`);
  }

  // 3. challenge_layer agreement between session and MCP export
  try {
    const sessChallenge = session?.challengeLayer || null;
    const mcpChallenge = mcpObject?.challenge_layer || null;
    if (sessChallenge && mcpChallenge && sessChallenge !== mcpChallenge) {
      warnings.push(
        `challenge_layer mismatch: session=${sessChallenge} vs mcp=${mcpChallenge}`
      );
    }
  } catch (e) {
    warnings.push(`challenge-layer consistency check failed: ${e.message}`);
  }

  return warnings;
}
