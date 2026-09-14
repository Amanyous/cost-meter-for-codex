import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchWithRetry, readJsonBounded } from '../net.js'
import { CODING_PLAN_PROVIDERS, queryCodingPlan, qwenTokenPlanWindows, scnetTokenPlanWindows } from '../coding-plans.js'
import { queryCustomBalance } from '../custom-balance.js'
import { queryGatewayQuota } from '../gateway-quotas.js'

const OFFICIAL_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_CACHE = 'balances.json'

function credentialCtx(config) {
  const credentials = {
    resolve: async name => {
      const value = config?.credentials?.[name] || process.env[name]
      return typeof value === 'string' && value.trim() ? { value: value.trim() } : null
    },
  }
  return { get: name => name === 'credentials' ? credentials : undefined }
}

function keyFrom(config, entry, fallbackEnv = []) {
  if (typeof entry?.apiKey === 'string' && entry.apiKey.trim()) return entry.apiKey.trim()
  const envs = [entry?.apiKeyEnv, ...fallbackEnv].filter(Boolean)
  for (const name of envs) {
    const value = String(config?.credentials?.[name] || process.env[name] || '').trim()
    if (value) return value
  }
  return null
}

function getPath(root, path) {
  let current = root
  for (const segment of String(path || '').split('.')) {
    if (current === null || current === undefined || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
    current = current[segment]
  }
  return current
}

function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

export function extractByRule(data, rule) {
  if (typeof rule === 'number' && Number.isFinite(rule)) return rule
  if (typeof rule === 'string') return strictNumber(getPath(data, rule))
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) return null
  if (typeof rule.path === 'string') return strictNumber(getPath(data, rule.path))
  if (rule.op === 'divide') {
    const value = strictNumber(getPath(data, rule.path))
    const by = strictNumber(rule.by)
    return value !== null && by !== null && by !== 0 ? value / by : null
  }
  if ((rule.op === 'add' || rule.op === 'subtract') && Array.isArray(rule.paths)) {
    const values = rule.paths.map(path => strictNumber(getPath(data, path)))
    if (values.some(value => value === null)) return null
    return rule.op === 'add' ? values.reduce((sum, value) => sum + value, 0) : values.slice(1).reduce((sum, value) => sum - value, values[0] ?? 0)
  }
  return null
}

function resolveHeaders(headers) {
  const output = {}
  for (const [name, raw] of Object.entries(headers || {})) {
    if (typeof raw !== 'string') continue
    output[name] = raw.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, env) => String(process.env[env] || '').trim())
  }
  return output
}

async function queryOfficial(config, fetchImpl) {
  const entry = config.officialBalance || {}
  if (entry.enabled !== true) return { status: 'off' }
  const key = keyFrom(config, entry, ['DEEPSEEK_API_KEY'])
  if (!key) return { status: 'missing', error: 'DEEPSEEK_API_KEY is not configured' }
  try {
    const response = await fetchWithRetry(OFFICIAL_BALANCE_URL, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } }, { fetchImpl, attempts: 2, timeoutMs: 15000 })
    if (!response.ok) return { status: 'error', error: `HTTP ${response.status}` }
    const data = await readJsonBounded(response)
    const infos = Array.isArray(data?.balance_infos) ? data.balance_infos.map(info => ({
      currency: String(info.currency || ''),
      total: Number(info.total_balance) || 0,
      granted: Number(info.granted_balance) || 0,
      toppedUp: Number(info.topped_up_balance) || 0,
    })) : []
    return infos.length > 0 ? { status: 'ok', infos } : { status: 'error', error: 'balance_infos missing' }
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) }
  }
}

async function queryCustom(config, fetchImpl) {
  const rows = []
  const ctx = credentialCtx(config)
  for (const entry of Array.isArray(config.customBalances) ? config.customBalances : []) {
    if (entry?.enabled !== true) continue
    try {
      const value = await queryCustomBalance(ctx, { ...config, customBalance: entry }, { fetchImpl })
      rows.push({ id: entry.id || entry.label || 'custom', status: 'ok', ...value })
    } catch (error) {
      rows.push({ id: entry.id || entry.label || 'custom', label: entry.label || entry.id || 'Custom', status: error?.soft === true ? 'missing' : 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return rows
}

function daysFromEvents(events) {
  const days = {}
  for (const event of events || []) {
    const date = new Date(event.atMs)
    const pad = value => String(value).padStart(2, '0')
    const key = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    const day = days[key] ?? { byProviderModel: {} }
    const modelKey = `${event.provider}:${event.model}`
    const bucket = day.byProviderModel[modelKey] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) bucket[field] += Number(event.usage?.[field]) || 0
    day.byProviderModel[modelKey] = bucket
    days[key] = day
  }
  return days
}

async function queryPlans(config, events) {
  const rows = []
  for (const [id, entry] of Object.entries(config.codingPlans || {})) {
    if (entry?.enabled !== true || !CODING_PLAN_PROVIDERS[id]) continue
    const key = keyFrom(config, entry, CODING_PLAN_PROVIDERS[id].credentialEnvs || [])
    if (id === 'scnet' || id === 'qwen') {
      try {
        const windows = id === 'scnet'
          ? scnetTokenPlanWindows(daysFromEvents(events), entry, Date.now())
          : qwenTokenPlanWindows(daysFromEvents(events), entry, Date.now())
        rows.push({ id, label: CODING_PLAN_PROVIDERS[id].label || id, status: windows ? 'ok' : 'missing', windows: windows?.windows || {}, error: windows ? undefined : 'planCredits is not configured' })
      } catch (error) {
        rows.push({ id, label: CODING_PLAN_PROVIDERS[id].label || id, status: 'error', error: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    if (!key) {
      rows.push({ id, label: CODING_PLAN_PROVIDERS[id].label || id, status: 'missing', error: 'credential is not configured' })
      continue
    }
    try {
      const result = await queryCodingPlan(id, key, config.locale === 'en' ? 'en' : 'zh', (_locale, code, vars) => `${code}${vars ? ` ${JSON.stringify(vars)}` : ''}`)
      rows.push({ id, label: CODING_PLAN_PROVIDERS[id].label || id, status: 'ok', windows: result.windows || {}, endpoint: result.endpoint || null })
    } catch (error) {
      rows.push({ id, label: CODING_PLAN_PROVIDERS[id].label || id, status: error?.soft === true ? 'missing' : 'error', error: error instanceof Error ? error.message : String(error) })
    }
  }
  return rows
}

async function queryGateway(config, fetchImpl) {
  const rows = []
  const ctx = credentialCtx(config)
  for (const source of Array.isArray(config.gatewaySources) ? config.gatewaySources : []) {
    try {
      rows.push(await queryGatewayQuota(ctx, source, { fetchImpl }))
    } catch (error) {
      rows.push({ id: source?.id || 'gateway', label: source?.label || source?.id || 'Gateway', status: 'error', message: error instanceof Error ? error.message : String(error), accounts: [] })
    }
  }
  return rows
}

export function balanceCachePath(dataDir) {
  return join(dataDir, BALANCE_CACHE)
}

export function readBalanceCache(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(balanceCachePath(dataDir), 'utf8'))
    return { gateway: [], ...parsed }
  } catch {
    return { fetchedAt: null, official: { status: 'off' }, custom: [], codingPlans: [], gateway: [] }
  }
}

export function writeBalanceCache(dataDir, snapshot) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(balanceCachePath(dataDir), JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 })
  return snapshot
}

export async function refreshBalances(config, { fetchImpl = fetch, events = [] } = {}) {
  const [official, custom, codingPlans, gateway] = await Promise.all([
    queryOfficial(config, fetchImpl),
    queryCustom(config, fetchImpl),
    queryPlans(config, events),
    queryGateway(config, fetchImpl),
  ])
  return { fetchedAt: new Date().toISOString(), official, custom, codingPlans, gateway }
}
