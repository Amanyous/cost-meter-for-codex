const root = document.getElementById('root')
let state = null
let lastStateSignature = ''
let activeTab = 'overview'
let internalExpanded = false
let nextId = 1
const pending = new Map()

function request(method, params) {
  if (window.costMeterBridge?.request) return window.costMeterBridge.request(method, params)
  const id = nextId++
  window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*')
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`Bridge timeout: ${method}`))
    }, 15000)
  })
}

window.addEventListener('message', event => {
  if (event.source !== window.parent) return
  const message = event.data
  if (!message || message.jsonrpc !== '2.0') return
  if (message.id !== undefined && pending.has(message.id)) {
    const task = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) task.reject(new Error(message.error.message || String(message.error)))
    else task.resolve(message.result)
    return
  }
  if (message.method === 'ui/notifications/tool-result') {
    render(message.params?.structuredContent ?? message.params?.toolOutput ?? message.params)
    return
  }
  if (message.method === 'ui/notifications/host-context-changed' || message.method === 'ui/notifications/display-mode-changed') {
    render()
  }
})

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const num = value => Number(value) || 0
const tokens = value => {
  const n = num(value)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}K`
  return String(n)
}
const money = value => {
  const currency = state?.meta?.currency === 'CNY' ? 'CNY' : 'USD'
  const rate = currency === 'CNY' ? (num(state?.meta?.exchangeRate) || 1) : 1
  return `${currency === 'CNY' ? '¥' : '$'}${(num(value) * rate).toFixed(6)}`
}
const nativeMoney = (value, currency) => `${currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''}${num(value).toFixed(4)}${currency && currency !== 'CNY' && currency !== 'USD' ? ` ${currency}` : ''}`
const bucketText = bucket => `${tokens(bucket?.total)} tokens · ${num(bucket?.calls)} 次调用`
const hostApi = () => window.openai || {}
const availableDisplayModes = () => hostApi().availableDisplayModes || hostApi().hostContext?.availableDisplayModes || hostApi().view?.availableDisplayModes || []
const currentDisplayMode = () => hostApi().getDisplayMode?.() || hostApi().displayMode || hostApi().hostContext?.displayMode || hostApi().view?.displayMode || 'inline'
const normalizeDisplayMode = mode => {
  const value = String(mode || '').toLowerCase()
  if (value === 'picture-in-picture' || value === 'picture_in_picture') return 'pip'
  return value
}
const supportsMode = mode => {
  const wanted = normalizeDisplayMode(mode)
  const modes = availableDisplayModes().map(normalizeDisplayMode)
  return typeof hostApi().requestDisplayMode === 'function' && (modes.includes(wanted) || normalizeDisplayMode(currentDisplayMode()) === wanted)
}
const canRequestFullscreen = () => supportsMode('fullscreen')
const canRequestPip = () => supportsMode('pip')
const isFullView = () => internalExpanded || normalizeDisplayMode(currentDisplayMode()) === 'fullscreen'
const displayButton = () => `<button class="cm-btn small" data-action="collapse">${normalizeDisplayMode(currentDisplayMode()) === 'fullscreen' ? '收起面板' : '收起'}</button>`
const compactActions = () => `${canRequestPip() ? '<button class="cm-btn small" data-action="pip">悬浮面板</button>' : ''}<button class="cm-btn small primary" data-action="expand">展开面板</button>`

function peakInfo() {
  const peak = state?.meta?.peak
  if (!peak) return null
  const now = Date.now()
  const remaining = Math.max(0, Number(peak.nextAtMs) - now)
  const seconds = Math.floor(remaining / 1000)
  const text = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60)].map(value => String(value).padStart(2, '0')).join(':')
  const duration = Math.max(1, Number(peak.nextAtMs) - Number(peak.prevAtMs))
  const progress = Math.max(0, Math.min(100, (now - Number(peak.prevAtMs)) / duration * 100))
  return {
    current: peak.inPeak ? '峰时' : '平价',
    next: peak.nextIntoPeak ? '峰时' : '平价',
    countdown: text,
    progress,
    weekend: peak.weekend === true,
    inPeak: peak.inPeak === true,
  }
}

function peakTimeline() {
  const info = peakInfo()
  if (!info) return ''
  return `<div class="cm-codex-peak-timeline${info.inPeak ? ' peak' : ''}" data-peak-strip>
    <div class="cm-codex-peak-timeline-head">
      <span class="cm-peak-current" data-peak-now>${info.weekend ? '周末全谷价 · ' : ''}当前 ${info.current}</span>
      <span class="cm-peak-next" data-peak-next>下一时段 ${info.next} · ${info.countdown}</span><span class="cm-peak-progress" data-peak-progress>进度 ${info.progress.toFixed(0)}%</span>
    </div>
    <div class="cm-codex-peak-track"><i class="cm-codex-peak-marker" data-peak-marker style="left:${info.progress}%"></i></div>
    <div class="cm-codex-peak-axis"><span>峰时</span><span>平价</span></div>
  </div>`
}

function officialBalanceInfo() {
  const official = state?.balances?.official
  return official?.status === 'ok' ? official.infos?.[0] ?? null : null
}

function officialBalanceText() {
  const info = officialBalanceInfo()
  if (!info) return '余额未启用'
  return `${info.currency} ${num(info.total).toFixed(2)}`
}

function balanceBar(info) {
  const cap = Math.max(0, Number(state?.meta?.officialBalance?.budgetCap) || 0)
  const total = Math.max(0, Number(info?.total) || 0)
  const percent = cap > 0 ? Math.max(0, Math.min(100, total / cap * 100)) : 100
  return `<div class="cm-balance-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(1)}"><div class="cm-balance-fill" style="width:${percent}%"></div></div>`
}

function officialBalancePreview() {
  const info = officialBalanceInfo()
  if (!info) return `<div class="cm-balance-preview unavailable"><span>DeepSeek 余额</span><b>余额未启用</b></div>`
  const cap = Math.max(0, Number(state?.meta?.officialBalance?.budgetCap) || 0)
  return `<div class="cm-balance-preview">
    <div class="cm-balance-preview-head"><span>DeepSeek 余额</span><b>${nativeMoney(info.total, info.currency)}</b>${cap > 0 ? `<small>上限 ${nativeMoney(cap, info.currency)}</small>` : ''}</div>
    ${balanceBar(info)}
  </div>`
}

function budgetView(compact = false) {
  const budget = state?.budget
  if (!budget) return ''
  const percent = Math.max(0, Math.min(100, num(budget.percent)))
  const cls = budget.overBudget || percent >= 100 ? ' over' : percent >= 80 ? ' warn' : ''
  return `<div class="cm-codex-budget${compact ? ' compact' : ''}">
    <div class="cm-codex-budget-head"><span>${esc(budget.label)}</span><strong>${percent.toFixed(1)}%</strong></div>
    <div class="cm-go-bar"><div class="cm-go-fill${cls}" style="width:${percent}%"></div></div>
    <div class="cm-codex-budget-sub">${money(budget.spentUsd)} / ${money(budget.amountUsd)} · API 实际支出</div>
  </div>`
}

function heatmap(history) {
  const byDate = new Map((history || []).map(day => [day.date, day]))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const end = new Date(today)
  end.setDate(end.getDate() + (6 - (today.getDay() + 6) % 7))
  const weekCount = 26
  const cells = []
  let max = 1
  for (let week = weekCount - 1; week >= 0; week -= 1) {
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(end)
      date.setDate(date.getDate() - (week * 7 + (6 - index)))
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      const day = byDate.get(key)
      const total = num(day?.total)
      max = Math.max(max, total)
      cells.push({ date: key, total, costUsd: day?.costUsd, calls: day?.calls })
    }
  }
  return `<div class="cm-ug-grid" style="grid-template-columns:repeat(${weekCount},1fr)">${cells.map(cell => {
    const ratio = cell.total / max
    const level = cell.total <= 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4
    return `<div class="cm-ug-cell${level ? ` l${level}` : ''}" title="${esc(cell.date)} · ${tokens(cell.total)} tokens · ${money(cell.costUsd)}"></div>`
  }).join('')}</div>`
}

function compactView() {
  const today = state?.today || {}
  const session = state?.session || {}
  const modelCount = Array.isArray(state?.models) ? state.models.length : 0
  return `
    <div class="cm-codex-compact">
      <div class="cm-codex-compact-main">
        <div class="cm-codex-compact-head">
          <strong>Codex 费用</strong>
          <span>${esc(state?.meta?.dayKey || '')} · API 等价估算</span>
        </div>
        <div class="cm-codex-compact-metrics">
          <span><b>${money(today.costUsd)}</b><small>今日费用</small></span>
          <span><b>${money(session.costUsd)}</b><small>本会话</small></span>
          <span><b>${tokens(today.total)}</b><small>今日 Token</small></span>
          <span><b>${modelCount}</b><small>模型</small></span>
        </div>
        <div class="cm-codex-compact-extra">
          ${officialBalancePreview()}
          ${peakTimeline()}
        </div>
        ${budgetView(true)}
      </div>
      ${state?.unpriced?.length ? `<div class="cm-codex-warning">未定价：${state.unpriced.map(item => esc(`${item.provider}/${item.model}`)).join('、')}</div>` : ''}
      <div class="cm-codex-compact-actions">${compactActions()}</div>
    </div>
  `
}

function overview() {
  if (!state) return '<div class="cm-codex-loading">正在加载费用数据…</div>'
  const today = state.today || {}
  const session = state.session || {}
  return `
    <div class="cm-codex-header">
      <div><h2>Codex 费用</h2><p>${esc(state.meta?.dayKey || '')} · API 等价估算</p></div>
      <div class="cm-codex-actions">${displayButton()}<button class="cm-btn small" data-action="sync">同步历史</button></div>
    </div>
    <div class="cm-cards">
      <div class="cm-card cm-card-today"><p class="cm-card-title">今日费用</p><div class="cm-card-value cm-num">${money(today.costUsd)}</div><p class="cm-card-sub">${bucketText(today)}</p></div>
      <div class="cm-card cm-card-session"><p class="cm-card-title">本会话费用</p><div class="cm-card-value cm-num">${money(session.costUsd)}</div><p class="cm-card-sub">${bucketText(session)}</p></div>
      <div class="cm-card cm-card-total"><p class="cm-card-title">历史累计</p><div class="cm-card-value cm-num">${money(state.total?.costUsd)}</div><p class="cm-card-sub">${bucketText(state.total)}</p></div>
    </div>
    ${budgetView(false)}
    <div class="cm-codex-billing"><span>API 支出 <b>${money(state.total?.apiCostUsd)}</b></span><span>Plan 等值 <b>${money(state.total?.planEquivalentUsd)}</b></span><span>API / Plan <b>${num(state.total?.apiCalls)} / ${num(state.total?.planCalls)}</b></span></div>
    ${state.unpriced?.length ? `<div class="cm-codex-warning">未定价模型：${state.unpriced.map(item => esc(`${item.provider}/${item.model}`)).join('、')}</div>` : ''}
    <section class="cm-budget"><div class="cm-budget-head"><h3 class="cm-h">最近 26 周 Token 用量</h3></div>${heatmap(state.history)}</section>
  `
}

function classLabel(bucket) {
  const api = num(bucket?.apiCalls)
  const plan = num(bucket?.planCalls)
  if (api > 0 && plan > 0) return 'API + Plan'
  if (plan > 0) return 'Plan'
  return 'API'
}

function history() {
  const rows = (state?.history || []).slice(0, 30)
  return `<div class="cm-codex-header"><div><h2>历史记录</h2><p>最近 30 天费用、模型与计费分类</p></div><div class="cm-codex-actions">${displayButton()}<button class="cm-btn small" data-action="sync">同步历史</button></div></div>
    ${rows.length ? `<div class="cm-scroll"><table class="cm-table cm-table-history"><thead><tr><th>日期</th><th class="num">费用</th><th>分类</th><th>使用模型</th><th class="num">调用</th><th class="num">Token</th></tr></thead><tbody>${rows.map(day => {
      const models = [...(day.models || [])].sort((a, b) => b.costUsd - a.costUsd).slice(0, 3)
      return `<tr><td>${esc(day.date)}</td><td class="num cm-history-cost">${money(day.costUsd)}</td><td><span class="cm-class-badge ${num(day.planCalls) > 0 ? 'plan' : 'api'}">${classLabel(day)}</span></td><td><div class="cm-inline-tags">${models.map(model => `<span class="cm-model-tag">${esc(model.provider)} / ${esc(model.model)}</span>`).join('')}</div></td><td class="num">${num(day.calls)}</td><td class="num">${tokens(day.total)}</td></tr>`
    }).join('')}</tbody></table></div>` : '<p class="cm-empty">暂无历史记录</p>'}`
}

function models() {
  const rows = [...(state?.models || [])].sort((a, b) => b.costUsd - a.costUsd)
  const sessions = [...(state?.sessions || [])].sort((a, b) => b.costUsd - a.costUsd).slice(0, 12)
  const apiCost = rows.reduce((sum, row) => sum + num(row.apiCostUsd), 0)
  const planCost = rows.reduce((sum, row) => sum + num(row.planEquivalentUsd), 0)
  const apiCalls = rows.reduce((sum, row) => sum + num(row.apiCalls), 0)
  const planCalls = rows.reduce((sum, row) => sum + num(row.planCalls), 0)
  return `<div class="cm-codex-header"><div><h2>模型与分类</h2><p>模型使用量、费用对比与 API/Plan 分类</p></div><div class="cm-codex-actions">${displayButton()}</div></div>
    <div class="cm-model-summary">
      <div><small>API 支出</small><b>${money(apiCost)}</b><span>${apiCalls} 次调用</span></div>
      <div><small>Plan 等值</small><b>${money(planCost)}</b><span>${planCalls} 次调用</span></div>
      <div><small>使用模型</small><b>${rows.length}</b><span>按费用降序</span></div>
    </div>
    ${rows.length ? `<div class="cm-model-list">${rows.map(row => {
      const label = classLabel(row)
      const tone = label === 'Plan' ? 'plan' : label === 'API + Plan' ? 'mixed' : 'api'
      return `<article class="cm-model-card">
        <div class="cm-model-head"><div><span class="cm-provider-tag">${esc(row.provider)}</span><b>${esc(row.model)}</b></div><span class="cm-class-badge ${tone}">${label}</span></div>
        <div class="cm-model-cost"><strong>${money(row.costUsd)}</strong><small>${num(row.calls)} 次调用 · ${tokens(row.total)} tokens</small></div>
        <div class="cm-model-metrics"><span>输入 ${tokens(row.input)}</span><span>缓存 ${tokens(num(row.cacheRead) + num(row.cacheWrite))}</span><span>输出 ${tokens(row.output)}</span></div>
      </article>`
    }).join('')}</div>` : '<p class="cm-empty">暂无模型记录</p>'}
    <section class="cm-budget"><div class="cm-budget-head"><h3 class="cm-h">会话费用排行</h3></div>${sessions.length ? `<div class="cm-scroll"><table class="cm-table cm-table-sessions"><thead><tr><th>会话</th><th class="num">调用</th><th class="num">Token</th><th class="num">费用</th></tr></thead><tbody>${sessions.map(row => `<tr><td>${esc(String(row.id).slice(0, 12))}</td><td class="num">${num(row.calls)}</td><td class="num">${tokens(row.total)}</td><td class="num">${money(row.costUsd)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="cm-empty">暂无会话记录</p>'}</section>`
}

function balanceList() {
  const balances = state?.balances || {}
  const cards = []
  const official = balances.official || { status: 'off' }
  if (official.status === 'ok') {
    cards.push(`<div class="cm-codex-balance-card"><div class="cm-codex-balance-title">DeepSeek 官方余额</div>${(official.infos || []).map(info => `<div class="cm-codex-balance-row"><span>${esc(info.currency)}</span><b>${nativeMoney(info.total, info.currency)}</b><small>赠送 ${nativeMoney(info.granted, info.currency)} · 充值 ${nativeMoney(info.toppedUp, info.currency)}</small>${balanceBar(info)}</div>`).join('')}</div>`)
  } else {
    cards.push(`<div class="cm-codex-balance-card"><div class="cm-codex-balance-title">DeepSeek 官方余额</div><div class="cm-note">${official.status === 'missing' ? '未配置 API Key' : official.status === 'off' ? '未启用' : esc(official.error || official.status)}</div></div>`)
  }
  for (const item of balances.custom || []) {
    cards.push(`<div class="cm-codex-balance-card"><div class="cm-codex-balance-title">${esc(item.label)}</div><div class="cm-codex-balance-row"><span>${esc(item.status === 'ok' ? item.unit : '')}</span><b>${item.status === 'ok' ? num(item.remaining).toFixed(4) : esc(item.error || item.status)}</b></div></div>`)
  }
  for (const source of balances.gateway || []) {
    const accounts = (source.accounts || []).map(account => `<div class="cm-codex-balance-row"><span>${esc(account.provider || account.label || 'account')}</span><b>${esc(account.status || '')}</b><small>${(account.windows || []).map(win => `${esc(win.label || win.name || 'window')} ${num(win.percent).toFixed(1)}%`).join(' · ')}</small></div>`).join('')
    cards.push(`<div class="cm-codex-balance-card"><div class="cm-codex-balance-title">${esc(source.label || source.id || 'Gateway')}</div>${accounts || `<div class="cm-note">${esc(source.message || source.status || 'unknown')}</div>`}</div>`)
  }
  for (const item of balances.codingPlans || []) {
    const windows = Object.entries(item.windows || {}).map(([name, value]) => `<div class="cm-codex-balance-row"><span>${esc(name)}</span><b>${num(value.percent).toFixed(1)}%</b><small>${value.resetsAt ? `重置 ${esc(String(value.resetsAt).slice(0, 16).replace('T', ' '))}` : ''}</small></div>`).join('')
    cards.push(`<div class="cm-codex-balance-card"><div class="cm-codex-balance-title">${esc(item.label)}</div>${windows || `<div class="cm-note">${esc(item.error || item.status)}</div>`}</div>`)
  }
  return cards.join('')
}

function balances() {
  const fetchedAt = state?.balances?.fetchedAt
  return `<div class="cm-codex-header"><div><h2>余额与额度</h2><p>${fetchedAt ? `更新于 ${esc(String(fetchedAt).slice(0, 16).replace('T', ' '))}` : '尚未刷新'}</p></div><div class="cm-codex-actions">${displayButton()}<button class="cm-btn small" data-action="refresh-balances">刷新余额</button><button class="cm-btn small" data-action="sync">同步历史</button></div></div>
    <div class="cm-codex-balances">${balanceList() || '<p class="cm-empty">没有启用任何余额或额度查询</p>'}</div>`
}

function settings() {
  const budget = state?.meta?.budgetConfig || {}
  const planProviders = (state?.meta?.planProviders || []).join(', ')
  const planModels = (state?.meta?.planModels || []).join(', ')
  return `<div class="cm-codex-header"><div><h2>设置</h2><p>预算与 Plan/API 计费配置</p></div><div class="cm-codex-actions">${displayButton()}</div></div>
    <div class="cm-budget cm-codex-form">
      <p class="cm-note">语言：${esc(state?.meta?.locale || 'auto')} · 币种：${esc(state?.meta?.currency || 'USD')} · 汇率：${esc(state?.meta?.exchangeRate || '')}</p>
      <label>显示货币<select id="cm-currency"><option value="USD"${state?.meta?.currency !== 'CNY' ? ' selected' : ''}>美元 USD</option><option value="CNY"${state?.meta?.currency === 'CNY' ? ' selected' : ''}>人民币 CNY</option></select></label>
      <label>美元兑人民币汇率<input id="cm-exchange-rate" type="number" min="0.01" step="0.01" value="${esc(state?.meta?.exchangeRate || 7.2)}"></label>
      <label>预算金额<input id="cm-budget-amount" type="number" min="0" step="0.01" value="${esc(budget.amount || 0)}"></label>
      <label>预算周期<select id="cm-budget-period">${['daily','weekly','monthly','custom'].map(value => `<option value="${value}"${budget.period === value ? ' selected' : ''}>${value}</option>`).join('')}</select></label>
      <label>自定义开始<input id="cm-budget-start" type="date" value="${esc(budget.start || '')}"></label>
      <label>自定义结束<input id="cm-budget-end" type="date" value="${esc(budget.end || '')}"></label>
      <label>Plan providers（逗号分隔）<input id="cm-plan-providers" value="${esc(planProviders)}" placeholder="openai, chatgpt"></label>
      <label>Plan models（逗号分隔）<input id="cm-plan-models" value="${esc(planModels)}" placeholder="gpt-5.3-codex"></label>
      <label class="cm-codex-check"><input id="cm-official-enabled" type="checkbox"${state?.meta?.officialBalance?.enabled === true ? ' checked' : ''}> 启用 DeepSeek 官方余额查询</label>
      <label>官方余额环境变量名（不是 Key）<input id="cm-official-env" value="${esc(state?.meta?.officialBalance?.apiKeyEnv || 'DEEPSEEK_API_KEY')}"></label>
      <label>官方余额 Key（可选，仅本地保存）<input id="cm-official-key" type="password" value="" placeholder="留空则使用环境变量"></label>
      <label>官方余额上限（可选，用于进度条）<input id="cm-official-cap" type="number" min="0" step="0.01" value="${esc(state?.meta?.officialBalance?.budgetCap || 0)}"></label>
      <label class="cm-codex-check"><input id="cm-peak-alerts" type="checkbox"${state?.meta?.peakAlertsEnabled === true ? ' checked' : ''}> 启用峰谷切换系统通知（悬浮窗口）</label>
      <label>余额自动刷新间隔<select id="cm-balance-refresh">${[15,30,60,120,300].map(value => `<option value="${value}"${num(state?.meta?.balanceRefreshSec) === value ? ' selected' : ''}>${value} 秒</option>`).join('')}</select></label>
      <label class="cm-codex-wide">价格映射 JSON<textarea id="cm-price-overrides" rows="4">${esc(JSON.stringify(state?.meta?.priceOverrides || {}, null, 2))}</textarea></label>
      <label class="cm-codex-wide">自定义价格 JSON<textarea id="cm-custom-prices" rows="5">${esc(JSON.stringify(state?.meta?.customPrices || {}, null, 2))}</textarea></label>
      <label class="cm-codex-wide">DSH ledger 路径<input id="cm-dsh-path" placeholder="/path/to/ledger.json"></label>
      <label class="cm-codex-wide">余额/额度高级配置 JSON<textarea id="cm-balance-config" rows="6" placeholder='{"codingPlans":{"anthropic":{"enabled":true,"apiKeyEnv":"ANTHROPIC_OAUTH_TOKEN"}},"customBalances":[],"gatewaySources":[],"credentials":{}}'></textarea></label>
      <button class="cm-btn small primary" data-action="save-config">保存设置</button>
      <button class="cm-btn small" data-action="sync-prices">同步官方价格</button>
      <button class="cm-btn small" data-action="import-dsh">导入 DSH 历史</button>
      <button class="cm-btn small" data-action="reset-history">清除本地账本</button>
      <button class="cm-btn small" data-action="sync">同步全部 Codex 历史</button>
    </div>`
}

function render(nextState) {
  if (nextState && typeof nextState === 'object' && nextState.meta && nextState.total) {
    const merged = state ? { ...state, ...nextState, meta: { ...state.meta, ...nextState.meta } } : nextState
    const fullState = Array.isArray(nextState.history) || Array.isArray(nextState.models) || Array.isArray(nextState.sessions)
    const signature = JSON.stringify({
      dayKey: merged.meta?.dayKey,
      eventCount: merged.meta?.eventCount,
      today: merged.today,
      session: merged.session,
      budget: merged.budget,
      balances: merged.balances,
      peak: merged.meta?.peak ? { inPeak: merged.meta.peak.inPeak, nextAtMs: merged.meta.peak.nextAtMs } : null,
    })
    if (!fullState && signature === lastStateSignature) return
    lastStateSignature = signature
    state = merged
  }
  if (!state) return
  if (!isFullView()) {
    root.innerHTML = `<div class="cm-codex-shell">${compactView()}</div>`
    return
  }
  const body = activeTab === 'balances' ? balances() : activeTab === 'history' ? history() : activeTab === 'models' ? models() : activeTab === 'settings' ? settings() : overview()
  root.innerHTML = `<div class="cm-codex-shell"><div class="cm-codex-tabs">${[
    ['overview', '概览'], ['balances', '额度'], ['history', '历史'], ['models', '模型'], ['settings', '设置'],
  ].map(([id, label]) => `<button class="cm-codex-tab${activeTab === id ? ' active' : ''}" data-tab="${id}">${label}</button>`).join('')}</div>${peakTimeline()}${body}</div>`
}

root.addEventListener('click', async event => {
  const tab = event.target.closest('[data-tab]')
  if (tab) {
    activeTab = tab.dataset.tab
    const needsFull = (activeTab === 'history' && !Array.isArray(state?.history)) || (activeTab === 'models' && (!Array.isArray(state?.models) || !Array.isArray(state?.sessions)))
    if (needsFull) {
      const loading = await request('tools/call', { name: 'cost_ui_action', arguments: { action: 'refresh' } }).catch(() => null)
      if (loading?.structuredContent) render(loading.structuredContent)
    } else {
      render()
    }
    return
  }
  const action = event.target.closest('[data-action]')?.dataset.action
  if (action === 'sync-prices') {
    const response = await request('tools/call', { name: 'cost_ui_action', arguments: { action: 'sync_prices' } })
    render(response?.structuredContent)
  }
  if (action === 'import-dsh') {
    const path = document.getElementById('cm-dsh-path')?.value || ''
    if (path) {
      const response = await request('tools/call', { name: 'cost_ui_action', arguments: { action: 'import_dsh', path } })
      render(response?.structuredContent)
    }
  }
  if (action === 'reset-history') {
    if (window.confirm('确定清除 Codex 本地费用账本？')) {
      const response = await request('tools/call', { name: 'cost_ui_action', arguments: { action: 'reset_history' } })
      render(response?.structuredContent)
    }
  }
  if (action === 'refresh-balances') {
    const response = await request('tools/call', { name: 'cost_ui_action', arguments: { action: 'refresh_balances' } })
    render(response?.structuredContent)
  }
  if (action === 'sync') {
    const response = await request('tools/call', { name: 'cost_ui_action', arguments: { action: 'sync' } })
    render(response?.structuredContent)
  }
  if (action === 'expand') {
    if (canRequestFullscreen()) {
      try {
        const result = await hostApi().requestDisplayMode({ mode: 'fullscreen' })
        if (result?.mode === 'fullscreen') {
          render()
          return
        }
      } catch {}
    }
    internalExpanded = true
    render()
  }
  if (action === 'pip') {
    try {
      await hostApi().requestDisplayMode({ mode: 'picture-in-picture' })
      render()
    } catch {}
  }
  if (action === 'save-config') {
    const value = id => document.getElementById(id)?.value ?? ''
    const split = text => text.split(',').map(item => item.trim()).filter(Boolean)
    const patch = {
      currency: value('cm-currency') || 'USD',
      exchangeRate: Number(value('cm-exchange-rate')) || 7.2,
      budget: {
        amount: Number(value('cm-budget-amount')) || 0,
        period: value('cm-budget-period') || 'monthly',
        start: value('cm-budget-start') || null,
        end: value('cm-budget-end') || null,
      },
      planProviders: split(value('cm-plan-providers')),
      planModels: split(value('cm-plan-models')),
      officialBalance: {
        enabled: document.getElementById('cm-official-enabled')?.checked === true,
        apiKeyEnv: (() => {
          const env = value('cm-official-env')
          return env.startsWith('sk-') ? 'DEEPSEEK_API_KEY' : (env || 'DEEPSEEK_API_KEY')
        })(),
        budgetCap: Number(value('cm-official-cap')) || 0,
        ...((value('cm-official-key') || (value('cm-official-env').startsWith('sk-') ? value('cm-official-env') : '')) ? { apiKey: value('cm-official-key') || value('cm-official-env') } : {}),
      },
      priceOverrides: JSON.parse(value('cm-price-overrides') || '{}'),
      customPrices: JSON.parse(value('cm-custom-prices') || '{}'),
      peakAlertsEnabled: document.getElementById('cm-peak-alerts')?.checked === true,
      balanceRefreshSec: Number(value('cm-balance-refresh')) || 30,
    }
    const advanced = JSON.parse(value('cm-balance-config') || '{}')
    Object.assign(patch, advanced)
    const response = await request('tools/call', { name: 'cost_ui_action', arguments: { action: 'update_config', patch } })
    render(response?.structuredContent)
  }
  if (action === 'collapse') {
    if (normalizeDisplayMode(currentDisplayMode()) !== 'inline' && typeof hostApi().requestDisplayMode === 'function') {
      try { await hostApi().requestDisplayMode({ mode: 'inline' }) } catch {}
    }
    internalExpanded = false
    render()
  }
})

setInterval(() => {
  const info = peakInfo()
  if (!info) return
  document.querySelectorAll('[data-peak-now]').forEach(node => { node.textContent = `${info.weekend ? '周末全谷价 · ' : ''}当前 ${info.current}` })
  document.querySelectorAll('[data-peak-next]').forEach(node => { node.textContent = `下一时段 ${info.next} · ${info.countdown}` })
  document.querySelectorAll('[data-peak-marker]').forEach(node => { node.style.left = `${info.progress}%` })
  document.querySelectorAll('[data-peak-progress]').forEach(node => { node.textContent = `进度 ${info.progress.toFixed(0)}%` })
  document.querySelectorAll('[data-peak-strip]').forEach(node => node.classList.toggle('peak', info.inPeak))
}, 30000)

let refreshing = false
let refreshingBalances = false
async function refreshNow() {
  if (refreshing || document.hidden || activeTab === 'settings') return
  refreshing = true
  try {
    const response = await request('tools/call', { name: 'cost_ui_action', arguments: { action: 'poll' } })
    render(response?.structuredContent)
  } catch {
    // Keep the last successful snapshot while the bridge or session is busy.
  } finally {
    refreshing = false
  }
}

async function refreshBalancesIfStale() {
  if (refreshingBalances || document.hidden || activeTab === 'settings') return
  const fetchedAt = Date.parse(state?.balances?.fetchedAt || '')
  const refreshSec = Math.max(15, Number(state?.meta?.balanceRefreshSec) || 30)
  if (Number.isFinite(fetchedAt) && Date.now() - fetchedAt < refreshSec * 1000) return
  refreshingBalances = true
  try {
    const response = await request('tools/call', { name: 'cost_ui_action', arguments: { action: 'refresh_balances' } })
    render(response?.structuredContent)
  } catch {
    // Keep the last known balance on transient network or auth errors.
  } finally {
    refreshingBalances = false
  }
}

setInterval(refreshNow, 10000)
setInterval(refreshBalancesIfStale, 5000)
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNow() })
request('ui/initialize', { protocolVersion: '2026-01-26', capabilities: {} })
  .catch(() => {})
  .finally(refreshNow)
