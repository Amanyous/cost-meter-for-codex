import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_CONFIG = Object.freeze({
  locale: 'auto',
  currency: 'USD',
  exchangeRate: 7.2,
  includeSubagents: true,
  budget: Object.freeze({ amount: 0, period: 'monthly', start: null, end: null }),
  planProviders: Object.freeze([]),
  planModels: Object.freeze([]),
  officialBalance: Object.freeze({ enabled: false, apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: '', budgetCap: 0 }),
  customBalances: Object.freeze([]),
  codingPlans: Object.freeze({}),
  gatewaySources: Object.freeze([]),
  credentials: Object.freeze({}),
  customPrices: Object.freeze({}),
  peakAlertsEnabled: false,
  balanceRefreshSec: 30,
  priceOverrides: Object.freeze({}),
  officialPriceModels: Object.freeze({}),
  officialPriceMeta: Object.freeze({}),
})

function mergeConfig(base, patch) {
  const next = { ...base, ...(patch && typeof patch === 'object' ? patch : {}) }
  next.budget = { ...base.budget, ...(patch?.budget ?? {}) }
  next.planProviders = Array.isArray(next.planProviders) ? next.planProviders : []
  next.planModels = Array.isArray(next.planModels) ? next.planModels : []
  next.officialBalance = { ...base.officialBalance, ...(patch?.officialBalance ?? {}) }
  if (!next.officialBalance.apiKey && /^sk-/.test(String(next.officialBalance.apiKeyEnv || ''))) {
    next.officialBalance.apiKey = next.officialBalance.apiKeyEnv
    next.officialBalance.apiKeyEnv = 'DEEPSEEK_API_KEY'
  }
  next.customBalances = Array.isArray(next.customBalances) ? next.customBalances : []
  next.gatewaySources = Array.isArray(next.gatewaySources) ? next.gatewaySources : []
  next.credentials = { ...(base.credentials || {}), ...(patch?.credentials ?? {}) }
  next.customPrices = { ...(base.customPrices || {}), ...(patch?.customPrices ?? {}) }
  next.priceOverrides = { ...(base.priceOverrides || {}), ...(patch?.priceOverrides ?? {}) }
  next.officialPriceModels = { ...(base.officialPriceModels || {}), ...(patch?.officialPriceModels ?? {}) }
  next.officialPriceMeta = { ...(base.officialPriceMeta || {}), ...(patch?.officialPriceMeta ?? {}) }
  const planIds = new Set([...Object.keys(base.codingPlans || {}), ...Object.keys(patch?.codingPlans || {})])
  next.codingPlans = Object.fromEntries([...planIds].map(id => [id, { ...(base.codingPlans?.[id] ?? {}), ...(patch?.codingPlans?.[id] ?? {}) }]))
  return next
}

export function defaultDataDir(env = process.env) {
  if (env.COST_METER_DATA_DIR) return env.COST_METER_DATA_DIR
  if (env.PLUGIN_DATA) return env.PLUGIN_DATA
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex')
  return join(codexHome, 'cost-meter')
}

export function eventsPath(dataDir) {
  return join(dataDir, 'usage.jsonl')
}

export function configPath(dataDir) {
  return join(dataDir, 'config.json')
}

export function readConfig(dataDir) {
  try {
    return mergeConfig(DEFAULT_CONFIG, JSON.parse(readFileSync(configPath(dataDir), 'utf8')))
  } catch {
    return mergeConfig(DEFAULT_CONFIG, null)
  }
}

export function writeConfig(dataDir, patch) {
  mkdirSync(dataDir, { recursive: true })
  const next = mergeConfig(readConfig(dataDir), patch)
  writeFileSync(configPath(dataDir), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  return next
}

function cleanEvent(event) {
  return {
    key: String(event.key),
    threadId: String(event.threadId || 'thread'),
    turnId: String(event.turnId || ''),
    responseId: String(event.responseId || ''),
    atMs: Number(event.atMs) || Date.now(),
    cwd: typeof event.cwd === 'string' ? event.cwd : null,
    source: typeof event.source === 'string' ? event.source : null,
    isSubagent: event.isSubagent === true,
    callCount: Math.max(1, Number(event.callCount) || 1),
    provider: String(event.provider || 'unknown'),
    model: String(event.model || 'unknown'),
    usage: {
      input: Number(event.usage?.input) || 0,
      output: Number(event.usage?.output) || 0,
      cacheRead: Number(event.usage?.cacheRead) || 0,
      cacheWrite: Number(event.usage?.cacheWrite) || 0,
      reasoning: Number(event.usage?.reasoning) || 0,
      total: Number(event.usage?.total) || 0,
      raw: event.usage?.raw ?? undefined,
    },
  }
}

export function readEvents(dataDir) {
  const path = eventsPath(dataDir)
  if (!existsSync(path)) return []
  const byKey = new Map()
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = cleanEvent(JSON.parse(line))
      byKey.set(event.key, event)
    } catch {
      // Keep the ledger readable even if a crash left one torn line.
    }
  }
  return [...byKey.values()].sort((a, b) => a.atMs - b.atMs)
}

export function activeSessionPath(dataDir) {
  return join(dataDir, 'active-session.json')
}

export function readActiveSession(dataDir) {
  try {
    const value = JSON.parse(readFileSync(activeSessionPath(dataDir), 'utf8'))
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

export function writeActiveSession(dataDir, info) {
  mkdirSync(dataDir, { recursive: true })
  const value = {
    threadId: String(info?.threadId || ''),
    turnId: String(info?.turnId || ''),
    transcriptPath: typeof info?.transcriptPath === 'string' ? info.transcriptPath : null,
    cwd: typeof info?.cwd === 'string' ? info.cwd : null,
    model: typeof info?.model === 'string' ? info.model : null,
    atMs: Number(info?.atMs) || Date.now(),
  }
  writeFileSync(activeSessionPath(dataDir), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  return value
}

export function clearEvents(dataDir) {
  const path = eventsPath(dataDir)
  if (existsSync(path)) writeFileSync(path, '', { mode: 0o600 })
  return { cleared: true }
}

export function appendEvents(dataDir, events) {
  const incoming = Array.isArray(events) ? events : []
  if (incoming.length === 0) return { added: 0, total: readEvents(dataDir).length }
  mkdirSync(dataDir, { recursive: true })
  const existing = new Set(readEvents(dataDir).map(event => event.key))
  const lines = []
  for (const raw of incoming) {
    const event = cleanEvent(raw)
    if (!event.key || existing.has(event.key)) continue
    existing.add(event.key)
    lines.push(JSON.stringify(event))
  }
  if (lines.length > 0) appendFileSync(eventsPath(dataDir), lines.join('\n') + '\n', { mode: 0o600 })
  return { added: lines.length, total: existing.size }
}
