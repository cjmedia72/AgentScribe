import { exportPlaywright } from './playwright-exporter.js';
import { exportPostman } from './postman-exporter.js';
import { exportSOP } from './sop-exporter.js';
import { exportMCP } from './mcp-exporter.js';

// Bundles all 5 export formats into a single JSON file optimized for agent
// handoff. The agent gets one paste with the raw session + all derived formats.
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
    _meta: {
      schema: 'agentscribe-bundle',
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
      instructions_for_agent: [
        'This bundle is a single browser workflow recording in 5 representations.',
        'Most useful for automation: `mcp_output.api_map` lists the actual API endpoints the user\'s clicks fired, with payloads. `mcp_output.steps` is the action sequence.',
        'For browser-based replay: `playwright_script` is a runnable starting point.',
        'For API testing: `postman_collection` can be imported into Postman directly.',
        'For human context: `sop_markdown` is a readable walkthrough.',
        'For full fidelity / custom analysis: `raw_session` has every captured DOM and network event.',
        'Sensitive field values are marked [REDACTED] in the input events — substitute real values before replaying.',
        'Injectable fields in `raw_session.injectableFields` map form fields to POST param names — use this to parameterize the workflow over a list of inputs.'
      ]
    },
    raw_session: session,
    playwright_script: playwrightContent,
    postman_collection: postmanObject,
    sop_markdown: sopContent,
    mcp_output: mcpObject
  };

  return {
    content: JSON.stringify(bundle, null, 2),
    filename: `agentscribe-bundle-${Date.now()}.json`,
    mimeType: 'application/json'
  };
}
