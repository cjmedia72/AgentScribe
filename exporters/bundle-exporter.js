import { exportPlaywright } from './playwright-exporter.js';
import { exportPostman } from './postman-exporter.js';
import { exportSOP } from './sop-exporter.js';
import { exportMCP } from './mcp-exporter.js';

// Full bundle — all 5 formats embedded. Used for file download.
export function exportBundle(session) {
  let playwrightContent = null;
  let postmanObject = null;
  let sopContent = null;
  let mcpObject = null;

  try { playwrightContent = exportPlaywright(session).content; }
  catch (e) { playwrightContent = `// playwright export failed: ${e.message}`; }

  try { postmanObject = JSON.parse(exportPostman(session).content); }
  catch (e) { postmanObject = { error: `postman export failed: ${e.message}` }; }

  try { sopContent = exportSOP(session).content; }
  catch (e) { sopContent = `# SOP export failed: ${e.message}`; }

  try { mcpObject = JSON.parse(exportMCP(session).content); }
  catch (e) { mcpObject = { error: `mcp export failed: ${e.message}` }; }

  const bundle = {
    _meta: buildMeta(session, 'full'),
    raw_session: session,
    playwright_script: playwrightContent,
    postman_collection: postmanObject,
    sop_markdown: sopContent,
    mcp_output: mcpObject
  };

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

  const lean = {
    _meta: buildMeta(session, 'lean'),
    mcp: mcpObject,
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

  return {
    content: JSON.stringify(lean, null, 2),
    filename: filenameFor(session, 'lean'),
    mimeType: 'application/json'
  };
}

function buildMeta(session, variant) {
  return {
    schema: variant === 'lean' ? 'agentscribe-bundle-lean' : 'agentscribe-bundle',
    schema_version: '1.0',
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
      dropped_events: session.droppedEvents || 0
    },
    instructions_for_agent: variant === 'lean' ? [
      'Lean bundle for direct paste into an agent — optimized for context-window efficiency.',
      'Use `mcp.api_map` to call the recorded APIs directly (this is the highest-leverage data).',
      'Use `mcp.steps` for the action sequence and `injectable_fields` to parameterize over inputs.',
      'For full fidelity (raw events, response bodies, playwright/postman/sop), use the BUNDLE button instead of clipboard.'
    ] : [
      'Full bundle — one workflow recording in 5 representations.',
      '`mcp_output.api_map` lists the actual API endpoints the user\'s clicks fired, with payloads.',
      '`mcp_output.steps` is the action sequence.',
      '`playwright_script` is a runnable starting point for browser-based replay.',
      '`postman_collection` can be imported into Postman directly.',
      '`sop_markdown` is a readable walkthrough for humans.',
      '`raw_session` has every captured DOM and network event for forensic analysis.',
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
