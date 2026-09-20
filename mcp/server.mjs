#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { createCostMeter } from '../lib/codex/service.js'
import { readConfig, writeConfig } from '../lib/codex/ledger.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const UI_URI = 'ui://cost-meter/dashboard-v1.html'
const UI_MIME = 'text/html;profile=mcp-app'
const UI_PATH = join(root, 'lib', 'codex-ui.html')
const meter = createCostMeter()

export function threadIdFromMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return undefined
  for (const key of ['openai/threadId', 'openai/thread_id', 'codexThreadId', 'codex_thread_id', 'threadId', 'thread_id']) {
    if (typeof meta[key] === 'string' && meta[key].trim()) return meta[key].trim()
  }
  const raw = meta['x-codex-turn-metadata']
  try {
    const turn = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (typeof turn?.thread_id === 'string' && turn.thread_id.trim()) return turn.thread_id.trim()
  } catch {}
  return typeof meta.thread?.id === 'string' && meta.thread.id.trim() ? meta.thread.id.trim() : undefined
}
const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function assertTranscriptPath(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('transcript_path must be a non-empty string')
  const path = resolve(value)
  const inside = relative(codexHome, path)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error('transcript_path must be inside CODEX_HOME')
  if (!inside.endsWith('.jsonl')) throw new Error('transcript_path must point to a .jsonl rollout')
  if (!existsSync(path)) throw new Error('transcript_path does not exist')
  return path
}

function formatTokens(value) {
  const number = Number(value) || 0
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}K`
  return String(number)
}

function summaryText(state) {
  const today = state.today || {}
  const session = state.session || {}
  const currency = state.meta?.currency === 'CNY' ? 'CNY' : 'USD'
  const rate = currency === 'CNY' ? Number(state.meta?.exchangeRate) || 1 : 1
  const symbol = currency === 'CNY' ? '¥' : '$'
  const amount = value => `${symbol}${(Number(value) || 0) * rate}`
  const lines = [
    `今日：${amount(today.costUsd)} · ${formatTokens(today.total)} tokens · ${today.calls || 0} 次调用`,
  ]
  if (session.id) lines.push(`本会话：${amount(session.costUsd)} · ${formatTokens(session.total)} tokens · ${session.calls || 0} 次调用`)
  if ((today.planCalls || 0) > 0) lines.push(`API 实际：${amount(today.apiCostUsd)} · Plan 等值：${amount(today.planEquivalentUsd)}`)
  if (state.budget) lines.push(`${state.budget.label}：${amount(state.budget.spentUsd)} / ${amount(state.budget.amountUsd)} · ${(state.budget.percent || 0).toFixed(1)}%`)
  if (state.unpriced?.length) lines.push(`未定价：${state.unpriced.map(item => `${item.provider}/${item.model}`).join('、')}`)
  return lines.join('\n')
}

export function widgetMeta() {
  const csp = { connectDomains: [], resourceDomains: [], frameDomains: [] }
  return {
    ui: { prefersBorder: true, csp },
    'ui/resourceUri': UI_URI,
    'openai/outputTemplate': UI_URI,
    'openai/widgetAccessible': true,
    'openai/widgetDescription': 'Codex local token and API-equivalent cost dashboard',
    'openai/widgetPrefersBorder': true,
    'openai/widgetCSP': { connect_domains: csp.connectDomains, resource_domains: csp.resourceDomains, frame_domains: csp.frameDomains },
  }
}

export const tools = [
  {
    name: 'cost_status',
    title: 'Codex 费用状态',
    description: '读取 Codex 本地会话 token 与 API 等价费用，可按会话、今日或全部历史汇总。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'today', 'all'], default: 'session' },
        threadId: { type: 'string' },
        cwd: { type: 'string' },
        transcriptPath: { type: 'string' },
        sync: { type: 'boolean', default: false },
        includeSubagents: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'record_turn',
    title: '记录 Codex 回合',
    description: '供 Codex lifecycle hook 使用：解析指定 rollout，追加尚未记录的 token_usage_record。',
    inputSchema: {
      type: 'object',
      properties: {
        transcript_path: { type: 'string' },
        session_id: { type: 'string' },
        turn_id: { type: 'string' },
        cwd: { type: 'string' },
        model: { type: 'string' },
      },
      required: ['transcript_path'],
    },
  },
  {
    name: 'render_cost_dashboard',
    title: '渲染费用面板',
    description: '把 cost_status 的结构化快照渲染为对话内 MCP Apps 费用面板。',
    inputSchema: {
      type: 'object',
      properties: { snapshot: { type: 'object' } },
    },
    _meta: {
      ui: { resourceUri: UI_URI },
      'ui/resourceUri': UI_URI,
      'openai/outputTemplate': UI_URI,
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': '正在渲染费用面板…',
      'openai/toolInvocation/invoked': '费用面板已渲染。',
    },
  },
  {
    name: 'cost_ui_action',
    title: '费用面板操作',
    description: '供费用面板执行刷新、同步和简单配置保存。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['refresh', 'poll', 'sync', 'update_config', 'day_sessions', 'refresh_balances', 'import_dsh', 'reset_history', 'sync_prices'] },
        patch: { type: 'object' },
        date: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['action'],
    },
  },
]

export async function callTool(name, args = {}, meta = {}) {
  const metaThreadId = threadIdFromMeta(meta)
  const threadId = args.threadId || metaThreadId
  if (metaThreadId) meter.setActiveThread(metaThreadId)
  if (name === 'cost_status') {
    const state = await meter.status({
      scope: args.scope,
      threadId,
      cwd: args.cwd,
      transcriptPath: args.transcriptPath ? assertTranscriptPath(args.transcriptPath) : undefined,
      sync: args.sync === true,
      includeSubagents: args.includeSubagents !== false,
    })
    return {
      content: [{ type: 'text', text: summaryText(state) }],
      structuredContent: state,
    }
  }

  if (name === 'record_turn') {
    const transcriptPath = assertTranscriptPath(args.transcript_path)
    const sessionId = args.session_id || metaThreadId
    const synced = sessionId ? await meter.syncThread(sessionId) : await meter.syncFile(transcriptPath)
    meter.setActiveSession({
      threadId: sessionId,
      turnId: args.turn_id,
      transcriptPath: synced.latest || transcriptPath,
      cwd: args.cwd,
      model: args.model,
      atMs: Date.now(),
    })
    return {
      content: [{ type: 'text', text: `已记录 ${synced.added} 条 usage。` }],
      structuredContent: synced,
    }
  }

  if (name === 'render_cost_dashboard') {
    const state = args.snapshot && typeof args.snapshot === 'object' ? args.snapshot : await meter.status({ scope: 'session', threadId })
    return {
      content: [{ type: 'text', text: summaryText(state) }],
      structuredContent: state,
    }
  }

  if (name === 'cost_ui_action') {
    if (args.action === 'refresh') {
      const state = await meter.refreshActive({ scope: 'session', threadId })
      return { content: [{ type: 'text', text: summaryText(state) }], structuredContent: state }
    }
    if (args.action === 'poll') {
      const state = await meter.status({ scope: 'session', lite: true, threadId })
      return { content: [{ type: 'text', text: summaryText(state) }], structuredContent: state }
    }
    if (args.action === 'refresh_balances') {
      await meter.refreshBalances()
      const state = await meter.status({ scope: 'session', lite: true, threadId })
      return { content: [{ type: 'text', text: summaryText(state) }], structuredContent: state }
    }
    if (args.action === 'sync_prices') {
      const result = await meter.syncPrices({ locale: readConfig(meter.dataDir)?.locale })
      const state = await meter.status({ scope: 'session', threadId })
      return { content: [{ type: 'text', text: `已同步官方价格：${Object.keys(result.models).length} 个模型。\n${summaryText(state)}` }], structuredContent: state }
    }
    if (args.action === 'import_dsh' && typeof args.path === 'string') {
      const imported = await meter.importDsh(args.path)
      const state = await meter.status({ scope: 'session', threadId })
      return { content: [{ type: 'text', text: `已导入 ${imported.added} 条 DSH 记录。\n${summaryText(state)}` }], structuredContent: state }
    }
    if (args.action === 'reset_history') {
      await meter.resetHistory()
      const state = await meter.status({ scope: 'session', threadId })
      return { content: [{ type: 'text', text: `已清除本地账本。\n${summaryText(state)}` }], structuredContent: state }
    }
    if (args.action === 'sync') {
      const synced = await meter.sync()
      const state = await meter.status({ scope: 'session', threadId })
      return { content: [{ type: 'text', text: `已同步 ${synced.added} 条记录。\n${summaryText(state)}` }], structuredContent: state }
    }
    if (args.action === 'update_config' && args.patch && typeof args.patch === 'object') {
      writeConfig(meter.dataDir, args.patch)
      const state = await meter.status({ scope: 'session', lite: true, threadId })
      return { content: [{ type: 'text', text: summaryText(state) }], structuredContent: state }
    }
    if (args.action === 'day_sessions') {
      const state = await meter.status({ scope: 'session', threadId })
      const day = state.history.find(item => item.date === args.date)
      return { content: [{ type: 'text', text: `已读取 ${args.date} 的会话明细。` }], structuredContent: day || { date: args.date, sessions: [] } }
    }
  }

  throw new Error(`Unknown tool: ${name}`)
}

export function uiResource() {
  const text = existsSync(UI_PATH)
    ? readFileSync(UI_PATH, 'utf8')
    : '<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:16px">Codex cost dashboard bundle is missing. Run <code>npm run build:codex-ui</code>.</body>'
  return {
    uri: UI_URI,
    mimeType: UI_MIME,
    text,
    _meta: widgetMeta(),
  }
}

export async function dispatch(message) {
  const { id, method, params } = message
  try {
    if (method === 'initialize') {
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: params?.protocolVersion || '2025-11-25',
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: 'codex-cost-meter', title: 'Codex Cost Meter', version: '0.1.0', description: 'Local Codex token and API-equivalent cost meter.' },
        instructions: '使用 cost_status 查询 token 与 API 等价费用；使用 render_cost_dashboard 显示费用面板。hook 通过 record_turn 增量记录。',
      } }
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } }
    if (method === 'tools/call') return { jsonrpc: '2.0', id, result: await callTool(params?.name, params?.arguments || {}, params?._meta || {}) }
    if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [{ uri: UI_URI, name: 'Codex 费用面板', title: 'Codex Cost Meter', description: 'Codex token and API-equivalent cost dashboard', mimeType: UI_MIME, _meta: widgetMeta() }] } }
    if (method === 'resources/read') {
      if (params?.uri !== UI_URI) throw new Error(`Unknown resource: ${params?.uri || ''}`)
      return { jsonrpc: '2.0', id, result: { contents: [uiResource()] } }
    }
    if (id !== undefined) return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
    return null
  } catch (cause) {
    return id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32602, message: cause instanceof Error ? cause.message : String(cause) } }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  process.stdin.resume()
  setInterval(() => {}, 0x7fffffff)
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', line => {
    if (!line.trim()) return
    let message
    try {
      message = JSON.parse(line)
    } catch (cause) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: cause instanceof Error ? cause.message : String(cause) } })
      return
    }
    if (message.id === undefined) return
    void dispatch(message).then(response => { if (response) send(response) })
  })
  input.on('close', () => process.exit(0))
}
