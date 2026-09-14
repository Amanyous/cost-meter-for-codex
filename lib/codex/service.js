import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PEAK_EFFECTIVE_AT,
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_PRICE_TABLE,
  DEFAULT_PROVIDER_PRICE_TABLE,
  costOf,
  normalizePrice,
  peakPhaseAt,
  providerPriceEntryFor,
  usdFromCost,
} from '../pricing.js'
import { appendEvents, defaultDataDir, readActiveSession, readConfig, readEvents, writeActiveSession, writeConfig } from './ledger.js'
import { readBalanceCache, refreshBalances, writeBalanceCache } from './balances.js'
import { importDshLedger, resetCodexLedger } from './import-dsh.js'
import { syncOfficialPrices } from './price-sync.js'
import { listRolloutFiles, readRolloutEvents } from './session-usage.js'

const emptyBucket = () => ({
  calls: 0,
  apiCalls: 0,
  planCalls: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total: 0,
  costUsd: 0,
  apiCostUsd: 0,
  planEquivalentUsd: 0,
  unpricedCalls: 0,
})

function addUsage(target, event, priced) {
  const calls = Math.max(1, Number(event.callCount) || 1)
  target.calls += calls
  target.input += event.usage.input
  target.output += event.usage.output
  target.cacheRead += event.usage.cacheRead
  target.cacheWrite += event.usage.cacheWrite
  target.reasoning += event.usage.reasoning
  target.total += event.usage.total
  target.costUsd += priced.costUsd
  target.apiCostUsd += priced.apiCostUsd
  target.planEquivalentUsd += Math.max(0, priced.costUsd - priced.apiCostUsd)
  if (priced.billingClass === 'plan') target.planCalls += calls
  else target.apiCalls += calls
  if (!priced.priced) target.unpricedCalls += 1
}

export function localDayKey(atMs, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(atMs))
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${value.year}-${value.month}-${value.day}`
}

export function defaultSessionsRoot(env = process.env) {
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')
}

function buildPrices(config = {}) {
  return {
    currency: 'USD',
    exchangeRate: 1,
    models: { ...DEFAULT_PRICE_TABLE.models, ...(config.officialPriceModels || {}) },
    providers: DEFAULT_PROVIDER_PRICE_TABLE,
  }
}

export function billingClassOf(event, config) {
  const provider = String(event.provider || '').toLowerCase()
  const model = String(event.model || '').toLowerCase()
  const planProviders = (config.planProviders || []).map(value => String(value).toLowerCase())
  const planModels = (config.planModels || []).map(value => String(value).toLowerCase())
  return planProviders.includes(provider) || planModels.includes(model) ? 'plan' : 'api'
}

function dateKey(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function budgetWindow(config, nowMs = Date.now()) {
  const budget = config?.budget || {}
  const amount = Number(budget.amount)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const now = new Date(nowMs)
  const period = budget.period || 'monthly'
  let start
  let end
  let label
  if (period === 'custom' && /^\d{4}-\d{2}-\d{2}$/.test(String(budget.start || ''))) {
    start = String(budget.start)
    const rawEnd = /^\d{4}-\d{2}-\d{2}$/.test(String(budget.end || '')) ? String(budget.end) : dateKey(now)
    const next = new Date(`${rawEnd}T00:00:00`)
    next.setDate(next.getDate() + 1)
    end = dateKey(next)
    label = `${start} → ${rawEnd}`
  } else if (period === 'daily') {
    start = dateKey(now)
    const next = new Date(now)
    next.setDate(next.getDate() + 1)
    end = dateKey(next)
    label = '每日预算'
  } else if (period === 'weekly') {
    const day = new Date(now)
    const offset = (day.getDay() + 6) % 7
    day.setDate(day.getDate() - offset)
    start = dateKey(day)
    const next = new Date(day)
    next.setDate(next.getDate() + 7)
    end = dateKey(next)
    label = '每周预算'
  } else {
    start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    end = dateKey(next)
    label = '每月预算'
  }
  return { amount, period, start, end, label }
}

export function createCostMeter(options = {}) {
  const env = options.env || process.env
  const dataDir = options.dataDir || defaultDataDir(env)
  const sessionsRoot = options.sessionsRoot || defaultSessionsRoot(env)
  const now = typeof options.now === 'function' ? options.now : Date.now
  const transcriptCache = new Map()

  function priceEvent(event, config, prices) {
    const billingClass = billingClassOf(event, config)
    const custom = config.customPrices?.[`${event.provider}:${event.model}`]
    const customEntry = custom ? normalizePrice(custom) : null
    const resolved = customEntry ? { entry: customEntry, priced: customEntry.unpriced !== true, billingMode: 'flat' } : providerPriceEntryFor(event.provider, event.model, prices, { mode: 'auto', overrides: config.priceOverrides })
    if (!resolved?.priced || !resolved.entry) {
      return { costUsd: 0, apiCostUsd: 0, priced: false, billingClass, billingMode: resolved?.billingMode || 'flat' }
    }
    const deepseek = String(event.provider || '').toLowerCase().includes('deepseek') || String(event.model || '').toLowerCase().includes('deepseek')
    const peak = resolved.billingMode === 'deepseek-peak' || deepseek
      ? { enabled: true, effectiveAtMs: Date.parse(DEFAULT_PEAK_EFFECTIVE_AT), windows: DEFAULT_PEAK_WINDOWS }
      : { enabled: false }
    const localCost = costOf(event.usage, resolved.entry, event.atMs, peak)
    const costUsd = usdFromCost(localCost, 'USD', 1)
    return {
      costUsd,
      apiCostUsd: billingClass === 'api' ? costUsd : 0,
      priced: true,
      billingClass,
      billingMode: resolved.billingMode,
    }
  }

  async function syncFiles(files = null) {
    const targets = files ? [...files] : await listRolloutFiles(sessionsRoot)
    const incoming = []
    for (const file of targets) {
      try {
        const stat = statSync(file)
        const cached = transcriptCache.get(file)
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) continue
        const parsed = await readRolloutEvents(file)
        transcriptCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs })
        incoming.push(...parsed.events)
      } catch {
        // A missing or temporarily locked rollout must not break the rest.
      }
    }
    return appendEvents(dataDir, incoming)
  }

  async function syncThread(threadId) {
    if (typeof threadId !== 'string' || threadId.length === 0) return { added: 0, total: readEvents(dataDir).length, files: 0, latest: null }
    const targets = (await listRolloutFiles(sessionsRoot)).filter(file => file.includes(threadId))
    const latest = targets
      .map(file => ({ file, mtimeMs: statSync(file).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || null
    const result = await syncFiles(targets)
    return { ...result, files: targets.length, latest }
  }

  async function status(input = {}) {
    const lite = input.lite === true
    const config = readConfig(dataDir)
    const prices = buildPrices(config)
    if (input.sync === true || readEvents(dataDir).length === 0) {
      if (input.transcriptPath) await syncFiles([input.transcriptPath])
      else await syncFiles()
    }
    const dayKey = localDayKey(now())
    const allEvents = input.includeSubagents === false
      ? readEvents(dataDir).filter(event => event.isSubagent !== true)
      : readEvents(dataDir)
    const sourceFilter = input.transcriptPath || null
    const events = sourceFilter ? allEvents.filter(event => event.source === sourceFilter) : allEvents

    const total = emptyBucket()
    const today = emptyBucket()
    const days = new Map()
    const sessions = new Map()
    const models = new Map()
    const unpriced = new Map()

    const pricedEvents = events.map(event => ({ event, priced: priceEvent(event, config, prices) }))
    for (const { event, priced } of pricedEvents) {
      addUsage(total, event, priced)
      if (localDayKey(event.atMs, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') === dayKey) {
        addUsage(today, event, priced)
      }

      const date = localDayKey(event.atMs, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
      const day = days.get(date) ?? { date, ...emptyBucket(), sessionIds: new Set() }
      addUsage(day, event, priced)
      day.sessionIds.add(event.threadId)
      days.set(date, day)

      const session = sessions.get(event.threadId) ?? {
        id: event.threadId,
        cwd: event.cwd,
        lastAtMs: event.atMs,
        ...emptyBucket(),
      }
      addUsage(session, event, priced)
      session.lastAtMs = Math.max(session.lastAtMs, event.atMs)
      session.cwd ||= event.cwd
      sessions.set(event.threadId, session)

      const modelKey = `${event.provider}:${event.model}`
      const model = models.get(modelKey) ?? { provider: event.provider, model: event.model, ...emptyBucket() }
      addUsage(model, event, priced)
      models.set(modelKey, model)

      if (!priced.priced) {
        const key = `${event.provider}:${event.model}`
        const row = unpriced.get(key) ?? { provider: event.provider, model: event.model, calls: 0 }
        row.calls += 1
        unpriced.set(key, row)
      }
    }

    const sessionList = [...sessions.values()]
    const active = readActiveSession(dataDir)
    let activeSession = input.threadId ? sessions.get(input.threadId) : null
    if (!activeSession && active?.threadId) activeSession = sessions.get(active.threadId) ?? null
    if (!activeSession && input.transcriptPath) {
      const match = events.find(event => event.source === input.transcriptPath)
      activeSession = match ? sessions.get(match.threadId) : null
    }
    if (!activeSession && input.cwd) {
      activeSession = sessionList.filter(session => session.cwd === input.cwd).sort((a, b) => b.lastAtMs - a.lastAtMs)[0] ?? null
    }
    if (!activeSession) activeSession = sessionList.sort((a, b) => b.lastAtMs - a.lastAtMs)[0] ?? null

    let history = []
    if (!lite) {
      history = [...days.values()]
      .map(day => ({
        ...day,
        sessions: pricedEvents
          .filter(({ event }) => localDayKey(event.atMs, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') === day.date)
          .reduce((rows, { event, priced }) => {
            const row = rows.get(event.threadId) ?? { id: event.threadId, cwd: event.cwd, ...emptyBucket() }
            addUsage(row, event, priced)
            rows.set(event.threadId, row)
            return rows
          }, new Map()),
        models: pricedEvents
          .filter(({ event }) => localDayKey(event.atMs, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') === day.date)
          .reduce((rows, { event, priced }) => {
            const key = `${event.provider}:${event.model}`
            const row = rows.get(key) ?? { provider: event.provider, model: event.model, ...emptyBucket() }
            addUsage(row, event, priced)
            rows.set(key, row)
            return rows
          }, new Map()),
      }))
      .map(day => ({ ...day, sessionIds: undefined, sessions: [...day.sessions.values()], models: [...day.models.values()] }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 180)
    }

    const window = budgetWindow(config, now())
    let budget = null
    if (window) {
      let spentUsd = 0
      let equivalentCostUsd = 0
      let calls = 0
      const exchangeRate = config.currency === 'CNY' && Number(config.exchangeRate) > 0 ? Number(config.exchangeRate) : 1
      for (const { event, priced } of pricedEvents) {
        const key = localDayKey(event.atMs, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
        if (key < window.start || key >= window.end) continue
        spentUsd += priced.apiCostUsd
        equivalentCostUsd += priced.costUsd
        calls += 1
      }
      budget = {
        ...window,
        spentUsd,
        equivalentCostUsd,
        amountUsd: exchangeRate > 0 ? window.amount / exchangeRate : window.amount,
        amountDisplay: window.amount,
        remainingUsd: Math.max(0, (exchangeRate > 0 ? window.amount / exchangeRate : window.amount) - spentUsd),
        percent: window.amount > 0 ? spentUsd / (window.amount / exchangeRate) * 100 : 0,
        overBudget: spentUsd >= (exchangeRate > 0 ? window.amount / exchangeRate : window.amount),
        calls,
      }
    }

    return {
      meta: {
        dayKey,
        generatedAt: now(),
        currency: config.currency,
        exchangeRate: config.exchangeRate,
        locale: config.locale,
        budgetConfig: config.budget,
        planProviders: config.planProviders,
        planModels: config.planModels,
        officialBalance: { enabled: config.officialBalance?.enabled === true, apiKeyEnv: config.officialBalance?.apiKeyEnv || 'DEEPSEEK_API_KEY', budgetCap: Math.max(0, Number(config.officialBalance?.budgetCap) || 0) },
        peak: peakPhaseAt(now(), DEFAULT_PEAK_WINDOWS),
        peakAlertsEnabled: config.peakAlertsEnabled === true,
        balanceRefreshSec: Math.max(15, Number(config.balanceRefreshSec) || 30),
        priceOverrides: config.priceOverrides,
        customPrices: config.customPrices,
        eventCount: events.length,
        dataDir,
      },
      total,
      today,
      budget,
      balances: readBalanceCache(dataDir),
      session: activeSession,
      ...(lite ? {} : {
        history,
        models: [...models.values()].sort((a, b) => b.costUsd - a.costUsd || b.total - a.total),
        sessions: sessionList.sort((a, b) => b.lastAtMs - a.lastAtMs),
      }),
      unpriced: [...unpriced.values()].sort((a, b) => b.calls - a.calls),
    }
  }

  async function refreshActive(input = {}) {
    const active = readActiveSession(dataDir)
    if (active?.transcriptPath) await syncFiles([active.transcriptPath])
    return status(input)
  }

  return {
    dataDir,
    sessionsRoot,
    getConfig: () => readConfig(dataDir),
    updateConfig: patch => writeConfig(dataDir, patch),
    readEvents: () => readEvents(dataDir),
    setActiveSession: info => writeActiveSession(dataDir, info),
    refreshActive,
    sync: () => syncFiles(),
    syncFile: file => syncFiles([file]),
    syncThread,
    refreshBalances: async options => writeBalanceCache(dataDir, await refreshBalances(readConfig(dataDir), { ...(options || {}), events: readEvents(dataDir) })),
    importDsh: path => importDshLedger(dataDir, path),
    syncPrices: async options => {
      const result = await syncOfficialPrices(options)
      writeConfig(dataDir, { officialPriceModels: result.models, officialPriceMeta: { url: result.url, fetchedAt: result.fetchedAt, currency: result.currency } })
      return result
    },
    resetHistory: () => resetCodexLedger(dataDir),
    status,
  }
}
