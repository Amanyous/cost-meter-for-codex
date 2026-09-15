import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'

const dir = new URL('../src/client/', import.meta.url)
const source = readdirSync(dir).filter(n => n.endsWith('.js')).sort().map(n => readFileSync(new URL(n, dir), 'utf8')).join('')
let factory
let now = Date.parse('2026-09-08T08:00:00Z')
let updates = 0
class Clock extends Date { static now() { return now } }
vm.runInNewContext(source.replace('exports.apply = apply', 'exports.test = { css, makeT, formatResetCountdown, miniMaxResetText, miniMaxRow, MiniMaxPlanCard, CodingPlanBox, GatewayQuotaBox, CodexPlanBox, codexQuotaCache }; exports.apply = apply'), {
  Date: Clock,
  window: { __ModuleLoader__: { load: v => { factory = v.factory } }, localStorage: { getItem: () => null } },
  navigator: { language: 'en' },
})
const el = (type, props, ...children) => ({ type, props: props ?? {}, children })
const React = { createElement: el, Fragment: 'fragment', useState: init => [typeof init === 'function' ? init() : init, () => { updates++ }], useEffect() {}, useRef: value => ({ current: value }) }
const ui = factory(name => name === 'react' ? React : { Tooltip: 'tooltip' }).test
const assertNoNativeTitle = node => {
  if (Array.isArray(node)) { node.forEach(assertNoNativeTitle); return }
  if (node === null || typeof node !== 'object') return
  assert.equal(node.props?.title, undefined, '卡片及其子节点不触发第二层原生提示')
  for (const child of node.children ?? []) assertNoNativeTitle(child)
}
const zh = ui.makeT('zh'), en = ui.makeT('en')
const end = new Date(now + 90 * 60000).toISOString()
assert.equal(ui.formatResetCountdown(end, zh, now), '剩余 1小时30分')
assert.equal(ui.formatResetCountdown(end, en, now), '1h 30m left')
assert.equal(ui.formatResetCountdown(new Date(now + 1000).toISOString(), zh, now), '剩余 1分钟')
assert.equal(ui.formatResetCountdown(new Date(now + 2 * 86400000 + 3 * 3600000).toISOString(), en, now), '2d 3h left')
assert.equal(ui.formatResetCountdown(end, zh, now + 90 * 60000), '已到重置时间')
for (const resetsAt of ['', 'invalid', null, 42, undefined]) assert.equal(ui.miniMaxResetText({ resetsAt }, zh, now), '')
const win = { percent: 25, resetsAt: end }
const view = ui.miniMaxRow('完整的长窗口名称', win, 'remaining', zh)
assert.equal(view.row.props.title, undefined, '行元素不设原生 title，避免与外层卡片 Tooltip 重叠冲突')
assert.equal(view.row.children[2].children[0], '75%')
assert.equal(view.row.children[0].props.title, undefined, '子标签不设原生 title')
const state = { config: { locale: 'zh', codexQuotaEnabled: true, barDirections: { plan: 'remaining' } }, codingPlans: { kimi: { status: 'ok', windows: { daily: win }, fetchedAt: now } } }
const snapshot = { accounts: [{ provider: 'codex', windows: [{ ...win, label: 'Weekly long account window' }] }, { provider: 'antigravity', windows: [{ ...win, label: 'Daily' }] }], fetchedAt: now }
ui.codexQuotaCache.status = 'ok'; ui.codexQuotaCache.windows = { weekly: win }
const cards = [
  () => ui.MiniMaxPlanCard({ five: win, seven: win, t: zh, direction: 'remaining' }),
  () => ui.CodingPlanBox({ id: 'kimi', state }),
  () => ui.GatewayQuotaBox({ source: { id: 'test' }, snapshot, state }),
  () => ui.CodexPlanBox({ state }),
]
for (const card of cards) {
  now = Date.parse('2026-09-08T08:00:00Z')
  const before = card()
  assertNoNativeTitle(before)
  assert.equal(before.props.label.props.style.whiteSpace, 'pre-line')
  assert.match(before.props.label.children[0], /剩余 75%/)
  assert.match(before.props.label.children[0], /剩余 1小时30分/)
  const oldUpdates = updates
  now += 31 * 60000
  before.children[0].props.onMouseEnter()
  assert.equal(updates, oldUpdates + 1, '悬停触发重新渲染')
  assert.match(card().props.label.children[0], /剩余 59分钟/)
  before.children[0].props.onFocus()
  assert.equal(updates, oldUpdates + 2, '键盘聚焦也更新')
}
const textOf = node => node == null ? '' : typeof node === 'object' ? node.children.map(textOf).join(' ') : String(node)
for (const rail of [
  ui.MiniMaxPlanCard({ five: win, seven: win, t: zh, direction: 'remaining', wide: false }),
  ui.CodingPlanBox({ id: 'kimi', state, wide: false }),
  ui.GatewayQuotaBox({ source: { id: 'test' }, snapshot, state, wide: false }),
  ui.CodexPlanBox({ state, wide: false }),
]) {
  assertNoNativeTitle(rail)
  assert.match(textOf(rail.children[0]), /75%/, '收窄侧栏与提示均显示剩余百分比')
  assert.doesNotMatch(textOf(rail.children[0]), /25%/)
}
const gateway = ui.GatewayQuotaBox({ source: { id: 'test' }, snapshot, state })
assert.match(gateway.props.label.children[0], /Codex · Weekly long account window/)
assert.doesNotMatch(gateway.props.label.children[0], /left|Resets:/, '浏览器为英文时仍遵守中文配置')
console.log('[ok] 侧栏提示：四类卡片无重复原生提示，保留中英文、方向、重置倒计时、悬停/聚焦与账号标签')

if (process.argv.includes('--fixture')) {
  const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
  const html = tree => {
    if (tree == null) return ''
    if (typeof tree !== 'object') return esc(tree)
    if (tree.type === 'fragment') return tree.children.map(html).join('')
    const { className, title, style } = tree.props
    const css = style ? Object.entries(style).map(([k,v]) => k.replace(/[A-Z]/g, x => '-'+x.toLowerCase())+':'+v).join(';') : ''
    return `<${tree.type}${className ? ` class="${esc(className)}"` : ''}${title ? ` title="${esc(title)}"` : ''}${css ? ` style="${esc(css)}"` : ''}>${tree.children.map(html).join('')}</${tree.type}>`
  }
  const panels = []
  for (const width of [240, 300]) for (const compact of [false, true]) {
    const rows = ['5h', 'Codex · Weekly long account window', 'Antigravity · 很长的中文窗口名称', '7d'].map((label, i) => html(ui.miniMaxRow(label, { ...win, percent: [25, 80, 100, 0][i] }, 'used', i%2 ? en : zh).row))
    panels.push(`<section><h2>${width}px ${compact ? '紧凑两列' : '标准'}</h2><div class="cm-footer-stack ${compact ? 'compact' : ''}" style="width:${width}px">${[0,1].map(i=>`<div class="cm-bbox cm-mm"><div class="cm-mm-title">${i ? '多账号网关' : 'Coding Plan'}</div>${rows.join('')}</div>`).join('')}</div></section>`)
  }
  writeFileSync(new URL('../.tmp-sidebar-qa.html', import.meta.url), `<!doctype html><meta charset="utf-8"><title>侧栏布局验证</title><style>:root{--dsw-alias-bg-layer-2:#f2f4f8;--dsw-alias-label-primary:#182035;--dsw-alias-label-secondary:#334;--dsw-alias-label-tertiary:#667;--dsw-alias-border-main:#ddd;--dsw-alias-border-l1:#ddd;--dsw-alias-bg-layer-3:#e3e8f0;--dsw-alias-state-business-primary:#4176e6;--dsw-alias-state-warn-primary:#b77305;--dsw-alias-state-error-primary:#d83b3b}body{font:14px Arial;padding:24px;background:#fff;color:#182035}main{display:flex;flex-wrap:wrap;gap:32px}h2{font-size:16px}${ui.css}</style><h1>侧栏布局验证（合成窗口数据）</h1><main>${panels.join('')}</main>`)
}
