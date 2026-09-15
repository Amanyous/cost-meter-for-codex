#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Keep the always-on-top floating panel alive across Codex restarts.
// `cost-meter float` is idempotent: it exits immediately when the panel is already running.
try {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const child = spawn(process.execPath, [join(root, 'scripts', 'cost-meter.mjs'), 'float'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
} catch {}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: 'At the start of this new Codex task, before the first normal answer, call the cost-meter skill once: call cost_status with scope "session", then call render_cost_dashboard with that snapshot so the user sees the compact cost card. Do not repeat this on later turns unless the user asks about cost.',
  },
}) + '\n')
