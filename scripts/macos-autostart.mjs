#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  process.stderr.write('macOS autostart is only available on macOS.\n')
  process.exit(1)
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = fileURLToPath(import.meta.url)
const label = 'com.amanyous.cost-meter-codex'

function openCodexApps() {
  for (const bundleId of ['com.openai.codex', 'com.bigpizzav3.codexplusplus']) {
    spawn('/usr/bin/open', ['-b', bundleId], { detached: true, stdio: 'ignore' }).unref()
  }
}

function startFloatingWindow() {
  spawn(process.execPath, [join(root, 'scripts', 'cost-meter.mjs'), 'float'], { detached: true, stdio: 'ignore' }).unref()
}

let syncing = false
let lastSyncAt = 0
function syncUsage() {
  if (syncing || Date.now() - lastSyncAt < 60000) return
  syncing = true
  lastSyncAt = Date.now()
  const child = spawn(process.execPath, [join(root, 'scripts', 'cost-meter.mjs'), 'sync'], { detached: true, stdio: 'ignore' })
  child.on('exit', () => { syncing = false })
  child.on('error', () => { syncing = false })
  child.unref()
}

if (!process.argv.includes('--install')) {
  openCodexApps()
  startFloatingWindow()
  syncUsage()
  if (process.argv.includes('--watch')) {
    let codexRunning = false
    setInterval(() => {
      const processes = spawnSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' }).stdout || ''
      const running = processes.split('\n').some(line => line.includes('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'))
      if (running && !codexRunning) startFloatingWindow()
      if (running) syncUsage()
      codexRunning = running
    }, 3000)
  }
  if (!process.argv.includes('--watch')) process.exit(0)
} else {
  const escapeXml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const agentsDir = join(homedir(), 'Library', 'LaunchAgents')
  const plistPath = join(agentsDir, `${label}.plist`)
  const domain = `gui/${process.getuid()}`
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(script)}</string>
    <string>--watch</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`

  mkdirSync(agentsDir, { recursive: true })
  writeFileSync(plistPath, plist)
  spawnSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' })
  const loaded = spawnSync('/bin/launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' })
  if (loaded.status !== 0) {
    process.stderr.write(loaded.stderr || 'Failed to load macOS autostart agent.\n')
    process.exit(loaded.status || 1)
  }

  process.stdout.write(`Installed macOS autostart: ${plistPath}\n`)
}
