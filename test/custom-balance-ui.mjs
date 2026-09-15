import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFileSync, readdirSync } from 'node:fs'
import { sanitizeConfig, applyConfigPatch } from '../lib/store.js'

// 执行真实客户端组件及回调：覆盖新增、展开、凭据输入、删除与读取币种。
// 仅在测试 VM 中暴露闭包函数，不在发布 bundle 中增加测试接口。
const dir = new URL('../src/client/', import.meta.url)
const source = readdirSync(dir).filter(name => name.endsWith('.js')).sort().map(name => readFileSync(new URL(name, dir), 'utf8')).join('')
const code = source.replace('exports.apply = apply', 'exports.test = { CustomBalancePanel, CustomBalanceEntryPanel, customBalanceUnitOf, parseConfig, makeT }; exports.apply = apply')
let factory
let slots = []
let cursor = 0
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment',
  useState: initial => {
    const i = cursor++
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
    return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next }]
  },
  useRef: value => ({ current: value }), useEffect() {},
}
vm.runInNewContext(code, { window: { __ModuleLoader__: { load: value => { factory = value.factory } } }, navigator: { language: 'en' } })
const ui = factory(name => name === 'react' ? react : {}).test
const render = (component, props) => { cursor = 0; return component(props) }
const nodes = tree => tree && typeof tree === 'object' ? [tree, ...(tree.children ?? []).flatMap(nodes)] : []
const textOf = tree => typeof tree === 'string' ? tree : (tree?.children ?? []).map(textOf).join('')
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && textOf(node) === label)

for (const locale of ['zh', 'en']) {
  slots = []
  const config = sanitizeConfig({ locale })
  let draft = structuredClone(config)
  const t = ui.makeT(locale)
  const state = { config, customBalances: [], customVarStatus: {} }
  const panelProps = () => ({ state, draft, setDraft: value => { draft = value }, api: {}, t })
  let tree = render(ui.CustomBalancePanel, panelProps())
  button(tree, t('aliyunBalanceAdd')).props.onClick()
  assert.equal(draft.customBalances.length, 1)
  assert.equal(draft.customBalances[0].adapter, 'aliyun')
  assert.equal(draft.customBalances[0].request.method, 'POST')
  assert.deepEqual(applyConfigPatch(config, draft).errors, [], '新增入口生成可保存配置')
  const parsed = ui.parseConfig(sanitizeConfig(draft), 'config')
  assert.equal(parsed.customBalances[0].adapter, 'aliyun', '刷新后类型不丢失')
  tree = render(ui.CustomBalancePanel, panelProps())
  const entryNode = nodes(tree).find(node => node.type === ui.CustomBalanceEntryPanel)
  slots = []
  let card = render(ui.CustomBalanceEntryPanel, entryNode.props)
  assert.ok(button(card, t('customBalanceRemove')), '仅剩一条也可删除')
  button(card, t('customBalanceOpenConfig')).props.onClick()
  card = render(ui.CustomBalanceEntryPanel, entryNode.props)
  assert.ok(textOf(card).includes(t('aliyunBalanceNote')))
  assert.ok(!textOf(card).includes(t('customBalanceUrl')), '固定 adapter 不展示无效 HTTP 配置')
  const fields = nodes(card).filter(node => node.props.target?.startsWith('customVar:'))
  assert.equal(fields.length, 3)
  assert.ok(fields.some(node => node.props.target === 'customVar:ALIBABA_CLOUD_ACCESS_KEY_SECRET'))
  assert.equal(ui.customBalanceUnitOf(config, { unit: 'CNY' }, { adapter: 'aliyun', unit: 'USD' }), 'CNY')
  assert.equal(ui.customBalanceUnitOf(config, { unit: 'USD' }, { adapter: 'aliyun', unit: 'CNY' }), 'USD')
  button(card, t('customBalanceRemove')).props.onClick()
  assert.equal(applyConfigPatch(config, draft).config.customBalances.length, 0)
}
console.log('[ok] 自定义余额界面：双语新增/展开/凭据行/删除/币种与配置往返通过')
