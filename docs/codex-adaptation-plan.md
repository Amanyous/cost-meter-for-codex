# Codex 适配规划

## 目标

在保留现有 DSH 插件的前提下，新增一个可独立安装的 Codex 插件：
统计 Codex 本地会话的 token、缓存命中、模型分布和 API 等价费用，并通过
MCP 工具按需展示。

实现按 provider-neutral 设计，不限于 GPT 订阅：本机 `custom`/API provider 按价格表精确计价，其他 Codex 可路由且有价目的模型同样统计。ChatGPT 订阅的实际额度/credits 只是后续可选数据源，不进入第一版。

## 已确认决策

- 不排除任何现有主要面板；完整 Web UI 是目标，按核心看板、设置与扩展面板分阶段完成。
- UI 使用 MCP Apps 内联/可展开 iframe；不注入 DSH 专属 slot。
- 费用按每个 turn 实际使用的 provider/model 分别计算，支持对话中模型切换。
- Codex 使用独立账本；可单向导入 DSH 历史，但不与 DSH 共享可写账本。
- Codex 插件不依赖 DSH 凭据库；需要联网凭据的功能使用环境变量或插件的本地私有配置。
- 支持 Linux、macOS、Windows；IDE、Cloud、remote 暂不支持。
- 先在本地完成任务、测试和验收；用户确认测试通过后才推送到 GitHub `origin`，默认使用功能分支，不直接覆盖 master。

## 结论：采用最小可行架构

Codex 扩展只使用三类稳定能力：

- 本地 stdio MCP server：提供费用查询工具。
- Lifecycle hooks：在回合结束时增量采集 usage。
- Skill：告诉 Codex 何时调用费用工具、如何解释结果。

服务器按需读取
`~/.codex/sessions/**/rollout-*.jsonl`，只消费
`token_usage_record.payload.usage`，不读取或保存对话正文。

不采用 DSH/Cordis 宿主 API，不移植现有 Web UI，不依赖网页 statusline hack。
Codex CLI 当前只能配置内置状态栏项，无法注入自定义费用状态栏；持久侧栏也不
是可扩展接口。

## 第一版边界

必须完成：

- 本会话 token：输入、缓存、输出、推理、调用次数。
- 当日、按会话、按模型费用汇总。
- 使用现有 `lib/pricing.js` 价格表和历史价格逻辑。
- 模型/provider 切换时按各自 turn 正确归属。
- 重复扫描、resume、fork、子代理记录不重复计费。
- 未定价模型明确标记，不回退套用错误价格。
- 通过 MCP Apps 在内联 iframe 中呈现 Web UI，并保留现有费用页的主要信息架构。

暂不包含：

- DSH 的余额查询、Coding Plan、Gateway Quota、峰谷提醒和完整设置 UI。
- Codex Cloud 任务、远程任务和没有本地 transcript 的调用。
- ChatGPT 订阅额度/credits 的实时余额。
- 复刻 DSH 专属的 sidebar/composer/settings slot；Codex 不提供这些宿主插槽。
- 尚未接入真实数据源时，不显示假的余额、额度或同步按钮。

## 文件规划

保持在当前仓库根目录，作为 Codex 插件根：

- `.codex-plugin/plugin.json`：插件身份、skills、MCP server 入口。
- `.mcp.json`：启动本地 `node ./mcp/server.mjs`。
- `hooks/hooks.json`：`Stop` 与 `SubagentStop` 调用 `record_turn`。
- `skills/cost-meter/SKILL.md`：自然语言触发与结果展示规范。
- `mcp/server.mjs`：实现最小 MCP stdio JSON-RPC，不引入 MCP SDK。
- `src/codex-ui/entry.js`：MCP Apps Web UI 入口。
- `src/codex-ui/host-adapter.js`：把现有 DSH UI 的 store/API 映射到 MCP bridge。
- `scripts/build-codex-ui.mjs`：复用现有 CSS，并产出 `lib/codex-ui.js`。
- `lib/codex/session-usage.js`：解析 rollout、turn_context 与 usage record。
- `lib/codex/usage-ledger.js`：追加式 JSONL、去重、日/会话聚合。
- `scripts/cost-meter.mjs`：无需启动 Codex 的 CLI 检查和回填入口。
- `test/codex-session-usage.mjs`：固定样例与重复/切换模型/恢复场景。
- `test/codex-mcp.mjs`：initialize、tools/list、tools/call 冒烟测试。

复用：

- `lib/pricing.js`：模型匹配、价格表、`costOf()`。
- `package.json`：保留 DSH 脚本，只增加 `test:codex`。

## MCP 工具

第一版暴露核心工具：

- `cost_status`：返回当前会话、今日或全部汇总；支持按 cwd/threadId 筛选。
- `record_turn`：hook 专用；接收 `transcript_path`、`session_id`、`turn_id`，
  扫描缺失 usage 并追加到本地账本。
- `render_cost_dashboard`：接收已整理的 snapshot，返回绑定 MCP Apps UI 的渲染结果。
- `cost_ui_action`：承载 Web UI 的配置保存、按天会话、排行和价格同步动作。

`cost_status` 无显式 threadId 时优先使用最近一次 hook 标记的活动会话，再按
cwd 中最新的 rollout 兜底。模型、token 桶、费用和未定价告警一并返回结构化内容。

## Web UI 移植

采用 MCP Apps，而不是伪造 Codex 侧栏：

- MCP server 注册 `ui://cost-meter/dashboard-v1.html`，MIME 为
  `text/html;profile=mcp-app`。
- `render_cost_dashboard` 的 `_meta.ui.resourceUri` 只绑定这个资源；数据工具不绑定
  UI，避免每次工具调用都重挂 iframe。
- 现有 `CostSection`、`UsagePanel`、`HistoryPanel` 及 `makeT`/格式化/表格组件
  作为主要复用对象；不重写一套外观相似但逻辑分叉的 UI。
- 用一个宿主适配层替换 DSH 的 `useCost` store 与 `remote.costMeter.*`：
  UI 的读取映射到 `cost_status`，按钮动作映射到 `cost_ui_action`，刷新后只替换
  tool result 快照。
- `scripts/build-codex-ui.mjs` 从现有 `src/client` 提取 CSS 和组件工厂，产出
  单文件 `lib/codex-ui.js`；DSH 构建链保持不变。
- 将 `--dsw-*` 主题变量桥接到 MCP Apps iframe 的亮/暗色；390px 宽度下优先
  单列，宽屏保留现有卡片、表格和 26 周热图。
- DSH 的 sidebar、composer dock、session header 和 settings slot 无法移植；
  Web UI 以对话内联面板/可展开面板为载体。

UI 分两段落地：

1. 核心看板：概览、今日、历史、Token 热图、模型与费用明细。
2. 设置与扩展：显示设置、价格表、自定义 provider；余额、Coding Plan、
   Gateway Quota 只有服务端适配成功后才显示对应面板。

## 数据与计费规则

- 每次上游响应只记 `token_usage_record`；绝不对累计 `token_count` 求和。
- 去重键：`thread_id + response_id`。
- 模型/provider 从同一 transcript 中最近一次 `turn_context` 继承。
- 只持久化：时间、thread/turn/response id、provider、model、token 桶。
- 账本使用追加式 `usage.jsonl`，读取时聚合；避免多进程读改写竞争。
- 缓存输入从总输入中拆出；cache write 单独保留，计费前用真实样本验证是否
  已包含在 input_tokens，避免重复收费。
- 费用在读取时按记录时间重算，价格表更新后历史仍可保持正确。

## 当前实现状态

- 已完成：Codex 插件清单、repo marketplace、MCP server、Stop/SubagentStop hooks、skill、CLI、本地 usage ledger、按 turn 模型切换计价、核心 MCP Apps 看板、预算与 Plan/API 双轨金额、DeepSeek 官方余额、自定义 Provider 余额和 Coding Plan 查询缓存。
- 已完成验证：Codex 专项测试、真实本机 rollout 回填、MCP stdio 握手、MCP Apps 浏览器渲染、DSH 原有完整回归。
- 已完成扩展：预算、Plan/API 双轨、DeepSeek 官方余额、自定义余额、Coding Plan、Gateway 多账号、阿里云/千问余额、SCNet/Qwen 本地 Credits、MCP Apps 额度页。
- 已完成：官方价格同步、自定义价格、DSH 历史导入、账本清除、峰谷时段条、悬浮窗系统通知、会话排行、高级余额 JSON 配置。
- 剩余差异：MCP Apps 内联 UI 的双语翻译和宿主级通知；悬浮窗口侧已完成系统通知。

## 实施顺序

1. 用当前真实 rollout 和现有测试生成最小 fixture，冻结解析契约。
2. 实现 `session-usage` + `usage-ledger`，先跑纯 Node 断言。
3. 封装 CLI，验证本机全部历史 rollup 的时间、模型和 token 总量。
4. 实现 MCP server 与 `cost_status` / `record_turn`。
5. 通过宿主适配层复用现有组件，产出 MCP Apps `lib/codex-ui.js`，实现
   `render_cost_dashboard` 与 `cost_ui_action`。
6. 加入 plugin manifest、hooks、skill，并使用 `plugin-creator` 生成个人
   marketplace 条目；hooks 首次运行需要在 Codex 中信任。
7. 在临时 `CODEX_HOME` 安装/启动插件，跑 MCP 冒烟测试、UI 渲染测试和一个真实
   Codex 回合。
8. 核心准确后再评估 app-server `thread/tokenUsage/updated` 或
   `account/usage/read` 集成。

## 验收标准

- 固定 fixture 的总量与逐条 usage 求和完全一致。
- 同一 transcript 重复扫描两次，账本不增加记录。
- fork/resume 复制的响应不会重复计费。
- 模型切换和子代理分别归属正确，日总计不重不漏。
- `cost_status` 输出 token 桶、API 等价费用、模型分布、未定价告警。
- MCP server 在纯 stdio 下完成 initialize、tools/list、tools/call。
- `render_cost_dashboard` 返回正确 MIME 和 UI resource，iframe 能渲染核心看板。
- UI 的刷新、切换日期、保存设置都通过 MCP 工具回写，不依赖 DSH/Cordis。
- 亮/暗主题、390px 手机宽度与桌面宽度均无溢出或不可读文本。
- 现有 `npm test` 继续通过。
- hook 未信任或 MCP 未连接时，按需 `cost_status` 仍可回填并工作。

## 主要风险

- rollout JSONL 不是稳定公开协议：解析器集中在一个文件，版本不匹配时跳过并
  报错；后续可切换到稳定 app-server token usage 事件。
- hook 必须由用户信任：插件安装后引导一次 `/hooks`，不把 hook 作为唯一数据源。
- 订阅计划的“实际花费”无法从本地 token 推出：第一版明确标为 API 等价估算。
- Codex CLI/桌面没有持久自定义费用侧栏：Web UI 只能在 MCP Apps iframe 中
  呈现，不能注入 DSH 的 sidebar/composer/settings slot。
- 现有 Web UI 与 DSH store/API 深度耦合：先做薄适配层；若某面板需要 DSH-only
  服务端能力，保留入口但明确标注不可用，不退化成假数据。

## 官方依据

- Hooks: https://learn.chatgpt.com/docs/hooks
- Codex App Server events: https://learn.chatgpt.com/docs/app-server
- Plugin packaging: https://developers.openai.com/plugins/build/plugins
- Custom MCP UI: https://developers.openai.com/plugins/build/chatgpt-ui
- Built-in statusline limits: https://learn.chatgpt.com/docs/developer-commands#configure-footer-items-with-statusline
