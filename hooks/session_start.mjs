#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = process.env.COST_METER_DATA_DIR || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'cost-meter')

// Keep the always-on-top floating panel alive across Codex restarts.
// `cost-meter float` is idempotent: it exits immediately when the panel is already running.
let launched = null
let failure = ''
try {
  const cli = join(root, 'scripts', 'cost-meter.mjs')
  // Linux hook runners may tear down their process group when the hook exits,
  // so start the CLI in its own session (setsid -f forks it away from us).
  const useSetsid = process.platform === 'linux'
  const child = useSetsid
    ? spawn('setsid', ['-f', process.execPath, cli, 'float'], { detached: true, stdio: 'ignore' })
    : spawn(process.execPath, [cli, 'float'], { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', (error) => { failure = error.message })
  child.unref()
  launched = child.pid ?? null
} catch (error) {
  failure = error?.message || String(error)
}

try {
  mkdirSync(dataDir, { recursive: true })
  appendFileSync(join(dataDir, 'float-launch.log'), `${new Date().toISOString()} platform=${process.platform} display=${process.env.DISPLAY || '-'} wayland=${process.env.WAYLAND_DISPLAY || '-'} pid=${launched ?? '-'}${failure ? ` error=${failure}` : ''}\n`)
} catch {}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: 'At the start of this new Codex task, before the first normal answer, call the cost-meter skill once: call cost_status with scope "session", then call render_cost_dashboard with that snapshot so the user sees the compact cost card. Do not repeat this on later turns unless the user asks about cost.',
  },
}) + '\n')
