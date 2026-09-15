import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eventsFromRecords, normalizeTokenUsage } from '../lib/codex/session-usage.js'
import { appendEvents, readEvents } from '../lib/codex/ledger.js'
import { createCostMeter } from '../lib/codex/service.js'
import { extractByRule, refreshBalances } from '../lib/codex/balances.js'
import { importDshLedger, resetCodexLedger } from '../lib/codex/import-dsh.js'

const root = mkdtempSync(join(tmpdir(), 'codex-cost-meter-'))
try {
  const usage = normalizeTokenUsage({
    input_tokens: 1000,
    cached_input_tokens: 400,
    cache_write_input_tokens: 0,
    output_tokens: 100,
    reasoning_output_tokens: 20,
    total_tokens: 1100,
  })
  assert.deepEqual(usage, {
    input: 600,
    output: 100,
    cacheRead: 400,
    cacheWrite: 0,
    reasoning: 20,
    total: 1100,
    raw: {
      inputTokens: 1000,
      cachedInputTokens: 400,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 20,
      totalTokens: 1100,
    },
  })

  const records = [
    { type: 'session_meta', payload: { id: 'thread-1', session_id: 'parent-1', cwd: '/work/demo', model_provider: 'custom' } },
    { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'deepseek-v4-flash', model_provider: 'custom', cwd: '/work/demo' } },
    {
      timestamp: '2026-09-14T03:00:00.000Z',
      ordinal: 1,
      type: 'token_usage_record',
      payload: {
        thread_id: 'thread-1', turn_id: 'turn-1', response_id: 'resp-1',
        usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 1100 },
      },
    },
    { type: 'turn_context', payload: { turn_id: 'turn-2', model: 'gpt-5.3-codex', model_provider: 'openai', cwd: '/work/demo' } },
    {
      timestamp: '2026-09-14T04:00:00.000Z',
      ordinal: 2,
      type: 'token_usage_record',
      payload: {
        thread_id: 'thread-1', turn_id: 'turn-2', response_id: 'resp-2',
        usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 200, reasoning_output_tokens: 30, total_tokens: 2200 },
      },
    },
    {
      timestamp: '2026-09-14T04:00:00.000Z',
      ordinal: 3,
      type: 'token_usage_record',
      payload: {
        thread_id: 'thread-1', turn_id: 'turn-2', response_id: 'resp-2',
        usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 200, reasoning_output_tokens: 30, total_tokens: 2200 },
      },
    },
  ]

  const parsed = eventsFromRecords(records, '/tmp/rollout.jsonl')
  assert.equal(parsed.events.length, 3)
  assert.equal(parsed.events[0].model, 'deepseek-v4-flash')
  assert.equal(parsed.events[1].model, 'gpt-5.3-codex')
  assert.equal(parsed.events[0].usage.input, 600)

  const dataDir = join(root, 'data')
  const first = appendEvents(dataDir, parsed.events)
  assert.equal(first.added, 2)
  assert.equal(readEvents(dataDir).length, 2)
  const second = appendEvents(dataDir, parsed.events)
  assert.equal(second.added, 0)

  const sessionsRoot = join(root, 'sessions', '2026', '09', '14')
  mkdirSync(sessionsRoot, { recursive: true })
  const rollout = join(sessionsRoot, 'rollout-2026-09-14T03-00-00-thread-1.jsonl')
  writeFileSync(rollout, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const meter = createCostMeter({ dataDir: join(root, 'service-data'), sessionsRoot: join(root, 'sessions'), now: () => Date.parse('2026-09-14T12:00:00Z') })
  const sync = await meter.sync()
  assert.equal(sync.added, 2)
  const state = await meter.status({ scope: 'session', threadId: 'thread-1' })
  assert.equal(state.session.id, 'thread-1')
  assert.equal(state.session.calls, 2)
  assert.equal(state.models.length, 2)
  assert.equal(state.today.calls, 2)
  assert.ok(state.today.costUsd > 0)
  assert.equal(state.unpriced.length, 0)
  assert.equal(state.history[0].models.length, 2)

  meter.updateConfig({
    planProviders: ['openai'],
    budget: { amount: 1, period: 'monthly', start: null, end: null },
  })
  const classified = await meter.status({ scope: 'session', threadId: 'thread-1' })
  assert.equal(classified.total.apiCalls, 1)
  assert.equal(classified.total.planCalls, 1)
  assert.ok(classified.total.apiCostUsd > 0)
  assert.ok(classified.total.apiCostUsd < classified.total.costUsd)
  assert.ok(classified.budget.spentUsd > 0)
  assert.equal(classified.budget.spentUsd, classified.total.apiCostUsd)
  assert.ok(classified.budget.percent > 0)

  const beforeCustomPrice = classified.total.costUsd
  meter.updateConfig({ customPrices: { 'custom:deepseek-v4-flash': { input: 1000, output: 1000, cachedInput: 100 } } })
  const repriced = await meter.status({ scope: 'session', threadId: 'thread-1' })
  assert.ok(repriced.total.costUsd > beforeCustomPrice)

  meter.updateConfig({ currency: 'CNY', exchangeRate: 7.2 })
  const cny = await meter.status({ scope: 'session', threadId: 'thread-1' })
  assert.equal(cny.meta.currency, 'CNY')
  assert.equal(cny.meta.exchangeRate, 7.2)
  assert.ok(cny.budget.amountUsd > 0)
  const again = await meter.syncFile(rollout)
  assert.equal(again.added, 0)

  assert.equal(extractByRule({ data: { balance: 12.5 } }, { path: 'data.balance' }), 12.5)
  assert.equal(extractByRule({ data: { total: 20, used: 5 } }, { op: 'subtract', paths: ['data.total', 'data.used'] }), 15)
  const balances = await refreshBalances({
    officialBalance: { enabled: true, apiKey: 'test-key' },
    customBalances: [{ id: 'demo', label: 'Demo', enabled: true, request: { url: 'https://example.com/balance' }, extract: { remaining: 'data.remaining' }, currency: 'USD' }],
    codingPlans: {},
  }, {
    fetchImpl: async url => {
      if (String(url).includes('deepseek.com')) {
        return new Response(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '9.5', granted_balance: '1', topped_up_balance: '8.5' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ data: { remaining: 7.25 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(balances.official.status, 'ok')
  assert.equal(balances.official.infos[0].total, 9.5)
  assert.equal(balances.custom[0].remaining, 7.25)

  const dshPath = join(root, 'dsh-ledger.json')
  writeFileSync(dshPath, JSON.stringify({
    version: 1,
    days: {
      '2026-09-13': {
        byProviderModel: { 'deepseek:deepseek-v4-flash': { input: 100, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 0, calls: 3, cost: 1 } },
      },
    },
  }))
  const importDir = join(root, 'import-data')
  const imported = importDshLedger(importDir, dshPath)
  assert.equal(imported.added, 1)
  assert.equal(readEvents(importDir)[0].callCount, 3)
  assert.equal(resetCodexLedger(importDir).remaining, 0)
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log('[ok] codex session usage and ledger')
