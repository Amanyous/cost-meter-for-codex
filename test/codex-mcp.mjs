import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'codex-cost-mcp-'))
const codexHome = join(root, '.codex')
const dataDir = join(root, 'plugin-data')
const sessions = join(codexHome, 'sessions', '2026', '09', '14')
mkdirSync(sessions, { recursive: true })
const rollout = join(sessions, 'rollout-2026-09-14T03-00-00-thread-mcp.jsonl')
const records = [
  { type: 'session_meta', payload: { id: 'thread-mcp', cwd: '/work/mcp', model_provider: 'custom' } },
  { type: 'turn_context', payload: { turn_id: 'turn-mcp', model: 'deepseek-v4-flash', model_provider: 'custom', cwd: '/work/mcp' } },
  {
    timestamp: '2026-09-14T03:00:00.000Z',
    ordinal: 1,
    type: 'token_usage_record',
    payload: {
      thread_id: 'thread-mcp', turn_id: 'turn-mcp', response_id: 'resp-mcp',
      usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 120, reasoning_output_tokens: 10, total_tokens: 1320 },
    },
  },
]
writeFileSync(rollout, records.map(record => JSON.stringify(record)).join('\n') + '\n')

process.env.CODEX_HOME = codexHome
process.env.PLUGIN_DATA = dataDir
const { dispatch, threadIdFromMeta } = await import('../mcp/server.mjs')
let id = 0
const call = async (method, params = {}) => {
  const response = await dispatch({ jsonrpc: '2.0', id: ++id, method, params })
  if (response?.error) throw new Error(response.error.message)
  return response.result
}

try {
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'))
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'startup')
  const sessionStart = readFileSync(new URL('../hooks/session_start.mjs', import.meta.url), 'utf8')
  assert.match(sessionStart, /render_cost_dashboard/)
  assert.deepEqual(hooks.hooks.SessionStart.map(entry => entry.matcher), ['startup', 'resume'])
  assert.match(sessionStart, /cost-meter\.mjs/)
  assert.match(sessionStart, /'float'/)
  const cli = readFileSync(new URL('../scripts/cost-meter.mjs', import.meta.url), 'utf8')
  assert.match(cli, /floating-window\.pid/)
  assert.match(cli, /resolveElectron/)
  assert.match(cli, /spawn\('\/usr\/bin\/open', \['-n'/)
  assert.match(cli, /\['-n', '-a', dirname\(dirname\(dirname\(electron\)\)\), '--args', app\]/)
  assert.match(cli, /spawn\(electron, \[app\]/)
  const macAutostart = readFileSync(new URL('../scripts/macos-autostart.mjs', import.meta.url), 'utf8')
  assert.match(macAutostart, /com\.openai\.codex/)
  assert.match(macAutostart, /com\.bigpizzav3\.codexplusplus/)
  assert.match(macAutostart, /cost-meter\.mjs.*float/)
  assert.match(macAutostart, /cost-meter\.mjs.*sync/)
  assert.match(macAutostart, /Library.*LaunchAgents|LaunchAgents/)
  assert.match(macAutostart, /--watch/)
  assert.match(macAutostart, /<key>KeepAlive<\/key>/)
  const server = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8')
  assert.match(server, /action === 'update_config'[\s\S]*lite: true/)
  const dashboard = readFileSync(new URL('../src/codex-ui/dashboard.js', import.meta.url), 'utf8')
  assert.match(dashboard, /Asia\/Shanghai/)
  assert.match(dashboard, /durationText/)
  const floatingWindow = readFileSync(new URL('../scripts/floating-window.mjs', import.meta.url), 'utf8')
  assert.match(floatingWindow, /alwaysOnTop: true/)
  assert.match(floatingWindow, /cost-meter:bridge/)

  const initialized = await call('initialize', { protocolVersion: '2025-11-25', capabilities: {} })
  assert.equal(initialized.serverInfo.name, 'codex-cost-meter')

  const listed = await call('tools/list')
  assert.ok(listed.tools.some(tool => tool.name === 'cost_status'))
  assert.ok(listed.tools.some(tool => tool.name === 'render_cost_dashboard'))

  const recorded = await call('tools/call', { name: 'record_turn', arguments: { transcript_path: rollout } })
  assert.equal(recorded.structuredContent.added, 1)
  assert.equal(threadIdFromMeta({ 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread-meta' }) }), 'thread-meta')
  assert.equal(threadIdFromMeta({ openai: { threadId: 'wrong' }, 'openai/threadId': 'thread-direct' }), 'thread-direct')
  const ui = await call('resources/read', { uri: 'ui://cost-meter/dashboard-v1.html' })
  assert.equal(ui.contents[0].mimeType, 'text/html;profile=mcp-app')
  assert.match(ui.contents[0].text, /cm-codex-shell/)

  const status = await call('tools/call', { name: 'cost_status', arguments: { scope: 'session' } })
  assert.equal(status.structuredContent.session.id, 'thread-mcp')
  assert.equal(status.structuredContent.session.calls, 1)
  const polled = await call('tools/call', { name: 'cost_ui_action', arguments: { action: 'poll' } })
  assert.equal(polled.structuredContent.session.id, 'thread-mcp')
  assert.equal(polled.structuredContent.history, undefined)
  assert.ok(status.structuredContent.session.costUsd > 0)
  const switched = await dispatch({
    jsonrpc: '2.0',
    id: ++id,
    method: 'tools/call',
    params: {
      name: 'cost_status',
      arguments: {},
      _meta: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'thread-switched' }) },
    },
  })
  assert.equal(switched.result.structuredContent.session.id, 'thread-switched')
  assert.equal(switched.result.structuredContent.session.calls, 0)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('[ok] codex MCP server')
