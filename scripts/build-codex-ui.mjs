#!/usr/bin/env node
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = resolve(root, 'src/client')
const fragments = readdirSync(clientDir).filter(name => name.endsWith('.js')).sort()
const source = fragments.map(name => readFileSync(resolve(clientDir, name), 'utf8')).join('')
const match = source.match(/const css = (\[[\s\S]*?\]\.join\('\\n'\))/)
if (!match) throw new Error('client CSS source not found')
const sharedCss = runInNewContext(match[1], Object.create(null), { timeout: 1000 })
const themeCss = readFileSync(resolve(root, 'src/codex-ui/theme.css'), 'utf8')
const js = readFileSync(resolve(root, 'src/codex-ui/dashboard.js'), 'utf8')
const template = readFileSync(resolve(root, 'src/codex-ui/dashboard.html'), 'utf8')
const html = template
  .replace('__COST_METER_CSS__', () => `${sharedCss}\n${themeCss}`)
  .replace('__COST_METER_JS__', () => js.replaceAll('</script', '<\\/script'))
const out = resolve(root, 'lib/codex-ui.html')
writeFileSync(out, html)
console.log(`${out} ${Buffer.byteLength(html, 'utf8')} bytes`)
