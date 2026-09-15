// 仅供一次性 DSH Profile 验证；通过 --patch 加载，不随 npm 包发布。
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { realpathSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export const name = 'cost-meter-compatibility-probe'
export const inject = ['costMeter']
export async function apply(ctx) {
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const home = resolve(process.env.DSH_HOME ?? '.')
  assert.ok(relative(repo, home).startsWith('.tmp-compat-'), '探针只允许在本仓库一次性 .tmp-compat-* 目录运行')
  const profileRequire = createRequire(join(home, 'profiles', 'web', 'package.json'))
  const pluginRequire = createRequire(profileRequire.resolve('dsh-cost-meter'))
  const hostRequire = createRequire(resolve(process.env.CM_HOST_PACKAGE))
  const installMode = process.env.CM_COMPAT_INSTALL_MODE === 'linked' ? 'linked' : 'packed'
  const peers = {}
  for (const pkg of ['@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-home-paths']) {
    const viaPlugin = realpathSync(pluginRequire.resolve(pkg))
    const viaHost = realpathSync(hostRequire.resolve(pkg))
    if (installMode === 'packed') assert.equal(viaPlugin, viaHost, `${pkg} 必须复用宿主的同一个模块文件`)
    peers[pkg] = viaPlugin === viaHost
  }
  const { Service } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis')).href)
  const scoped = ctx.isolate('llm')
  const isolatedLlm = new Service(scoped, 'llm')
  await ctx.costMeter.updateConfig({ hideOfficialBalance: true, goQuota: { enabled: false }, sidebarStyle: 'compact' })
  const before = await ctx.costMeter.getState()
  for (const sessionId of ['cm-probe-parent', 'cm-probe-child', undefined]) {
    const stream = scoped.waterfall(isolatedLlm, 'llm/stream', {
      provider: 'cm-test', model: 'unknown-model', ...(sessionId ? { sessionId } : {}),
    }, () => (async function* () {
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })())
    for await (const chunk of stream) assert.ok(chunk.type)
  }
  const after = await ctx.costMeter.getState()
  assert.equal(after.today.calls - before.today.calls, 3, '隔离服务三次合成用量均入账')
  assert.equal(after.today.input - before.today.input, 300)
  const snapshotPath = join(home, 'storages', 'cost-meter', 'scnet_official.json')
  mkdirSync(dirname(snapshotPath), { recursive: true })
  const captured = Date.now() - 1000
  try {
    await ctx.costMeter.updateConfig({ codingPlans: { scnet: { enabled: true, planCredits: 60000 } } })
    writeFileSync(snapshotPath, JSON.stringify({ used: 24338.72, total: 60000, fetchedAt: captured,
      resetsAt: new Date(Date.now() + 86400000).toISOString() }))
    const snapshot = await ctx.costMeter.getState()
    assert.equal(snapshot.codingPlans.scnet.windows.monthly.percent, 40.6)
    assert.equal(snapshot.codingPlans.scnet.fetchedAt, captured)
    assert.deepEqual(snapshot.today, after.today, '外部快照不改变本地用量')
    writeFileSync(snapshotPath, '{invalid')
    const fallback = await ctx.costMeter.getState()
    assert.match(fallback.codingPlans.scnet.windows.credits.text, /^0 \/ 60,000 Credits/)
    assert.deepEqual(fallback.today, after.today, '损坏快照也不改变本地用量')
  } finally { rmSync(snapshotPath, { force: true }) }
  const result = {
    hostVersion: hostRequire('./package.json').version,
    pluginVersion: pluginRequire('../package.json').version,
    sharedHostModules: peers,
    installMode,
    scnetSnapshotAndFallback: true,
    syntheticCalls: after.today.calls - before.today.calls,
    syntheticInputTokens: after.today.input - before.today.input,
    passed: true,
  }
  writeFileSync(join(home, 'compatibility-probe.json'), JSON.stringify(result, null, 2) + '\n')
  console.log('[cm-compatibility-probe] ' + JSON.stringify(result))
}
