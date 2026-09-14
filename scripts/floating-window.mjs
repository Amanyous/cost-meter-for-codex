#!/usr/bin/env node
import { app, BrowserWindow, ipcMain, Notification, screen } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callTool } from '../mcp/server.mjs'
import { DEFAULT_PEAK_WINDOWS, peakPhaseAt } from '../lib/pricing.js'
import { defaultDataDir, readConfig } from '../lib/codex/ledger.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
app.setName('Codex Cost Meter')
if (process.platform === 'linux') app.commandLine.appendSwitch('disable-vulkan')
const pidPath = join(defaultDataDir(), 'floating-window.pid')

function clearPid() {
  try {
    if (existsSync(pidPath) && readFileSync(pidPath, 'utf8').trim() === String(process.pid)) unlinkSync(pidPath)
  } catch {}
}

process.on('exit', clearPid)
app.on('before-quit', clearPid)

async function createWindow() {
  const workArea = screen.getPrimaryDisplay().workArea
  const width = 390
  const height = 430
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 320,
    minHeight: 260,
    x: workArea.x + workArea.width - width - 16,
    y: workArea.y + 16,
    alwaysOnTop: true,
    title: 'Codex Cost Meter',
    backgroundColor: '#101014',
    webPreferences: {
      preload: join(root, 'scripts', 'floating-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.on('preload-error', (_event, preloadPath, error) => console.error('[cost-meter] preload error', preloadPath, error))
  win.webContents.on('did-fail-load', (_event, code, description) => console.error('[cost-meter] load failed', code, description))
  win.webContents.on('console-message', (_event, level, message) => console.error(`[cost-meter:renderer:${level}] ${message}`))
  await win.loadFile(join(root, 'lib', 'codex-ui.html'))
  win.show()

  let lastPeak = peakPhaseAt(Date.now(), DEFAULT_PEAK_WINDOWS)?.inPeak
  setInterval(() => {
    const config = readConfig(defaultDataDir())
    const phase = peakPhaseAt(Date.now(), config.peakWindows || DEFAULT_PEAK_WINDOWS)
    if (config.peakAlertsEnabled === true && phase && phase.inPeak !== lastPeak && Notification.isSupported()) {
      new Notification({
        title: 'Codex 峰谷计价',
        body: phase.inPeak ? '已进入峰时计价' : '已进入平价计价',
      }).show()
    }
    if (phase) lastPeak = phase.inPeak
  }, 30000)
}

ipcMain.handle('cost-meter:bridge', async (_event, message) => {
  const method = message?.method
  console.error(`[cost-meter] bridge ${method || ''}`)
  if (method === 'ui/initialize') return {
    protocolVersion: '2026-01-26',
    hostCapabilities: {},
    availableDisplayModes: ['inline', 'fullscreen'],
    displayMode: 'inline',
  }
  if (method === 'tools/call') {
    const value = await callTool(message?.params?.name, message?.params?.arguments || {})
    console.error(`[cost-meter] bridge ${message?.params?.name} -> ${value?.structuredContent?.meta?.eventCount ?? 'ok'}`)
    return value
  }
  throw new Error(`Unsupported bridge method: ${method || ''}`)
})

ipcMain.handle('cost-meter:display-mode', (event, mode) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return { mode: 'inline' }
  win.setFullScreen(false)
  if (mode === 'fullscreen') {
    win.setSize(760, 700)
    win.center()
    return { mode: 'fullscreen' }
  }
  win.setSize(390, 430)
  const workArea = screen.getPrimaryDisplay().workArea
  win.setPosition(workArea.x + workArea.width - 406, workArea.y + 16)
  return { mode: 'inline' }
})

app.whenReady().then(() => {
  mkdirSync(dirname(pidPath), { recursive: true })
  writeFileSync(pidPath, String(process.pid), { mode: 0o600 })
  return createWindow()
})
app.on('window-all-closed', () => app.quit())
