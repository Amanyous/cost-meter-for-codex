#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { createCostMeter } from '../lib/codex/service.js'
import { writeConfig } from '../lib/codex/ledger.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: 'boolean', default: false },
    thread: { type: 'string' },
    cwd: { type: 'string' },
    transcript: { type: 'string' },
    set: { type: 'string', multiple: true },
  },
})

const meter = createCostMeter()
const scope = positionals[0] || 'session'

function parseValue(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (/^[\[{]/.test(value)) {
    try { return JSON.parse(value) } catch {}
  }
  return value
}

function setPath(target, path, value) {
  const parts = path.split('.').filter(Boolean)
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {}
    cursor = cursor[part]
  }
  if (parts.length > 0) cursor[parts.at(-1)] = value
}

// Codex installs plugins with a virtual store (node_modules/.package-map.json + .pnpm),
// so a bare `import('electron')` only works in a source checkout. Fall back to the store.
async function resolveElectron(root) {
  try {
    return (await import('electron')).default
  } catch {}
  try {
    for (const entry of readdirSync(join(root, 'node_modules', '.pnpm'))) {
      if (!entry.startsWith('electron@')) continue
      try {
        return (await import(pathToFileURL(join(root, 'node_modules', '.pnpm', entry, 'node_modules', 'electron', 'index.js')).href)).default
      } catch {}
    }
  } catch {}
  return null
}

if (scope === 'float') {
  const pidFile = join(meter.dataDir, 'floating-window.pid')
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (pid > 0) {
      process.kill(pid, 0)
      if (values.json) process.stdout.write(JSON.stringify({ running: true, pid }) + '\n')
      else process.stdout.write('Codex Cost Meter floating window is already running.\n')
      process.exit(0)
    }
  } catch {}
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const electron = await resolveElectron(root)
  if (!electron) {
    process.stderr.write([
      'Electron is not installed, or its binary download did not finish (the floating window needs it).',
      'Fix: run `pnpm install` in the plugin directory; if the binary download fails, retry with a mirror:',
      '  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm rebuild electron',
      '',
    ].join('\n'))
    process.exit(1)
  }
  const app = join(root, 'scripts', 'floating-window.mjs')
  const child = process.platform === 'darwin'
    // LaunchServices otherwise reuses another Electron.app instance and drops our app path.
    ? spawn('/usr/bin/open', ['-n', '-a', dirname(dirname(dirname(electron))), '--args', app], { detached: true, stdio: 'ignore' })
    : spawn(electron, [app], { detached: true, stdio: 'ignore' })
  child.unref()
  if (values.json) process.stdout.write(JSON.stringify({ running: true, pid: child.pid }) + '\n')
  else process.stdout.write('Codex Cost Meter floating window started.\n')
  process.exit(0)
}

if (!values.json) {
  process.stderr.write('🪙 cost-meter: scanning Codex sessions\n')
}

if (scope === 'sync') {
  const result = await meter.sync()
  if (values.json) process.stdout.write(JSON.stringify(result) + '\n')
  else process.stdout.write(`synced: +${result.added} events, ${result.total} total\n`)
} else if (scope === 'config') {
  const patch = {}
  for (const item of values.set || []) {
    const index = item.indexOf('=')
    if (index > 0) setPath(patch, item.slice(0, index), parseValue(item.slice(index + 1)))
  }
  const config = Object.keys(patch).length > 0 ? writeConfig(meter.dataDir, patch) : meter.getConfig()
  if (values.json) process.stdout.write(JSON.stringify(config, null, 2) + '\n')
  else process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
} else if (scope === 'sync-prices') {
  const result = await meter.syncPrices({ locale: meter.getConfig().locale })
  process.stdout.write(values.json ? JSON.stringify({ url: result.url, models: Object.keys(result.models).length }) + '\n' : `synced ${Object.keys(result.models).length} models\n`)
} else if (scope === 'import-dsh') {
  if (!positionals[1]) throw new Error('usage: cost-meter import-dsh <ledger.json>')
  const result = await meter.importDsh(positionals[1])
  process.stdout.write(values.json ? JSON.stringify(result) + '\n' : `imported: ${result.added} events\n`)
} else if (scope === 'reset') {
  const result = await meter.resetHistory()
  process.stdout.write(values.json ? JSON.stringify(result) + '\n' : `cleared: ${result.remaining} remaining\n`)
} else if (scope === 'balances') {
  if (positionals[1] === 'refresh') await meter.refreshBalances()
  const state = await meter.status({ scope: 'session' })
  if (values.json) process.stdout.write(JSON.stringify(state.balances, null, 2) + '\n')
  else process.stdout.write(JSON.stringify(state.balances, null, 2) + '\n')
} else {
  const state = await meter.status({
    scope,
    threadId: values.thread,
    cwd: values.cwd,
    transcriptPath: values.transcript,
    sync: scope === 'sync',
  })
  if (values.json) {
    process.stdout.write(JSON.stringify(state, null, 2) + '\n')
  } else {
    const row = state.session || state.today
    const currency = state.meta?.currency === 'CNY' ? 'CNY' : 'USD'
    const rate = currency === 'CNY' ? Number(state.meta?.exchangeRate) || 1 : 1
    const symbol = currency === 'CNY' ? '¥' : '$'
    const money = value => `${symbol}${((Number(value) || 0) * rate).toFixed(6)}`
    process.stdout.write(`today: ${money(state.today?.costUsd)} · ${state.today?.total || 0} tokens · ${state.today?.calls || 0} calls\n`)
    if (state.budget) process.stdout.write(`${state.budget.label}: ${money(state.budget.spentUsd)} / ${money(state.budget.amountUsd)} · ${(state.budget.percent || 0).toFixed(1)}%\n`)
    if ((state.today?.planCalls || 0) > 0) process.stdout.write(`API actual: ${money(state.today.apiCostUsd)} · Plan equivalent: ${money(state.today.planEquivalentUsd)}\n`)
    if (row?.id) process.stdout.write(`session ${row.id}: ${money(row.costUsd)} · ${row.total || 0} tokens · ${row.calls || 0} calls\n`)
    if (state.unpriced?.length) process.stdout.write(`unpriced: ${state.unpriced.map(item => `${item.provider}:${item.model}`).join(', ')}\n`)
  }
}
