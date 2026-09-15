import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { parseScnetSnapshot, readScnetSnapshot, SCNET_SNAPSHOT_MAX_BYTES, SCNET_SNAPSHOT_MAX_AGE_MS } from '../lib/scnet-snapshot.js'
import { apply } from '../lib/index.js'
import { stateSchema } from '../lib/typert.host.js'

const now = new Date(2026, 8, 8, 12).getTime()
const sample = { used: 24338.72, total: 60000, fetchedAt: new Date(now - 3600000).toISOString() }
const entry = { planCredits: 240000, planStart: '' }
const parsed = parseScnetSnapshot(sample, entry, now, 'zh')
assert.equal(parsed.windows.monthly.percent, 40.6)
assert.equal(parsed.windows.monthly.resetsAt, '', '采集时间不能冒充重置时间')
assert.equal(parsed.fetchedAt, now - 3600000)
assert.equal(parsed.windows.credits.text, '24,338.72 / 60,000 Credits (外部控制台快照)')
assert.match(parseScnetSnapshot(sample, entry, now, 'en').windows.credits.text, /external console snapshot/)
assert.equal(parseScnetSnapshot({ ...sample, used: 0 }, entry, now).windows.monthly.percent, 0)
assert.equal(parseScnetSnapshot({ ...sample, used: 72000 }, entry, now).windows.monthly.percent, 100)
assert.equal(parseScnetSnapshot({ used: 1, total: 10, at: now - 1000 }, entry, now).fetchedAt, now - 1000, '兼容 at 采集时间别名')
const reset = new Date(now + 86400000).toISOString()
assert.equal(parseScnetSnapshot({ ...sample, resetsAt: reset }, entry, now).windows.monthly.resetsAt, reset)
for (const field of ['used', 'total']) {
  for (const bad of [null, true, false, '', '10', NaN, Infinity, -1, undefined, [], {}]) {
    assert.equal(parseScnetSnapshot({ ...sample, [field]: bad }, entry, now), null, `${field} 拒绝 ${String(bad)}`)
  }
}
for (const bad of [null, [], 'text', {}, { ...sample, total: 0 },
  { ...sample, fetchedAt: 'bad-date' }, { ...sample, fetchedAt: '2026-09-08T10:00:00' },
  { ...sample, fetchedAt: now + 1 }, { ...sample, fetchedAt: now - SCNET_SNAPSHOT_MAX_AGE_MS - 1 },
  { ...sample, fetchedAt: 8.65e15 }, { ...sample, resetsAt: 'bad-date' }, { ...sample, resetsAt: now },
]) assert.equal(parseScnetSnapshot(bad, entry, now), null)
const boundary = new Date(2026, 9, 1, 0, 5).getTime()
assert.equal(parseScnetSnapshot({ ...sample, fetchedAt: boundary - 600000 }, entry, boundary), null, '刚跨月也不能沿用上一周期快照')
const explicitBoundary = new Date(2026, 9, 7, 0, 5).getTime()
assert.equal(parseScnetSnapshot({ ...sample, fetchedAt: explicitBoundary - 600000 }, { planStart: '2026-09-06' }, explicitBoundary), null, '遵守配置的订阅周期边界')
assert.ok(parseScnetSnapshot({ ...sample, fetchedAt: boundary - 600000, resetsAt: boundary + 86400000 }, entry, boundary), '显式官方重置时间优先于推算的本地周期')

const root = mkdtempSync(join(tmpdir(), 'cm-scnet-snapshot-'))
const oldHome = process.env.DSH_HOME
const disposers = []
try {
  const dir = join(root, 'storages', 'cost-meter')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'scnet_official.json')
  assert.equal(await readScnetSnapshot(path, entry, now), null, '文件不存在正常回退')
  writeFileSync(path, JSON.stringify(sample))
  assert.equal((await readScnetSnapshot(path, entry, now)).windows.monthly.percent, 40.6)
  for (const content of ['{', 'null', '[]', JSON.stringify(sample) + ' '.repeat(SCNET_SNAPSHOT_MAX_BYTES)]) {
    writeFileSync(path, content)
    assert.equal(await readScnetSnapshot(path, entry, now), null, '损坏/非对象/超大文件正常回退')
  }
  assert.equal(await readScnetSnapshot(dir, entry, now), null, '只读普通文件')
  rmSync(path)
  process.env.DSH_HOME = root
  const ledgerPath = join(dir, 'ledger.json')
  writeFileSync(ledgerPath, JSON.stringify({ version: 1, config: { locale: 'zh', hideOfficialBalance: true, goQuota: { enabled: false }, codingPlans: { scnet: { enabled: true, planCredits: 240000 } } }, days: {} }))
  let svc
  apply({
    on: () => () => {},
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    inject() {}, provide: (name, value) => { if (name === 'costMeter') svc = value },
    get: key => key === 'settings' ? { get: () => ({}) } : undefined,
    logger: console,
  })
  const baseline = await svc.getState()
  assert.match(baseline.codingPlans.scnet.windows.credits.text, /0 \/ 240,000 Credits \(est\.\)/)
  const initialLedger = readFileSync(ledgerPath, 'utf8')
  const captured = Date.now() - 60000
  const current = { ...sample, fetchedAt: captured, resetsAt: new Date(Date.now() + 86400000).toISOString() }
  writeFileSync(path, JSON.stringify(current))
  const official = await svc.getState()
  assert.equal(official.codingPlans.scnet.windows.monthly.percent, 40.6, '真实服务优先使用快照，包含 DSH 之外的用量')
  assert.equal(official.codingPlans.scnet.fetchedAt, captured)
  assert.equal(official.codingPlans.scnet.windows.monthly.resetsAt, current.resetsAt)
  assert.deepEqual(official.today, baseline.today, '外部用量不混入本地账本')
  assert.equal(readFileSync(ledgerPath, 'utf8'), initialLedger, '读取快照不改写账本')
  stateSchema.parse(official)
  assert.equal((await svc.getState()).codingPlans.scnet.fetchedAt, captured, '重复查询不刷新采集时间')
  writeFileSync(path, JSON.stringify({ ...current, used: 30000 }))
  const refreshed = await svc.refreshCodingPlan('scnet')
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.state.codingPlans.scnet.windows.monthly.percent, 50, '手动刷新重新读取外部文件')
  for (const bad of [{ ...current, fetchedAt: Date.now() - SCNET_SNAPSHOT_MAX_AGE_MS - 1000 }, { ...current, resetsAt: 'bad-date' }, { ...current, used: null }]) {
    writeFileSync(path, JSON.stringify(bad))
    assert.deepEqual((await svc.getState()).codingPlans.scnet.windows, baseline.codingPlans.scnet.windows, '坏快照回退估算而不污染其他状态')
  }
  writeFileSync(path, JSON.stringify(current))
  await svc.updateConfig({ locale: 'en' })
  assert.match((await svc.getState()).codingPlans.scnet.windows.credits.text, /external console snapshot/)
  const [duringDisable] = await Promise.all([
    svc.getState(),
    svc.updateConfig({ codingPlans: { scnet: { display: 'off' } } }),
  ])
  assert.equal(duringDisable.codingPlans.scnet.status, 'off', '进行中的文件读取不能恢复已关闭的来源')
  assert.equal((await svc.getState()).codingPlans.scnet.status, 'off', '关闭显示仍遵守门控')
  await svc.updateConfig({ codingPlans: { scnet: { display: 'settings', enabled: false } } })
  assert.equal((await svc.getState()).codingPlans.scnet.status, 'off', '关闭来源仍遵守门控')
} finally {
  for (const dispose of disposers.reverse()) await dispose()
  if (oldHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = oldHome
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  rmSync(root, { recursive: true, force: true })
}
console.log('[ok] SCNet 外部快照：真实服务优先级、精度/双语、采集/重置时间、过期/周期/坏文件回退与账本隔离')
