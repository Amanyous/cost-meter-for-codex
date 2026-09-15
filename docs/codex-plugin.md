# Codex 插件适配

本仓库现在同时包含原有 DSH 插件和 Codex 插件。Codex 适配层不会修改 DSH 的构建、账本或运行时。

## 已实现

- 本地 stdio MCP server：`cost_status`、`record_turn`、`render_cost_dashboard`、`cost_ui_action`
- `SessionStart` hook：新任务开始时自动调用费用工具并渲染一次紧凑面板
- `Stop` / `SubagentStop` hook：回合结束后增量记录 usage
- Codex skill：自然语言查询费用和打开面板
- CLI：`scripts/cost-meter.mjs`
- MCP Apps Web UI：对话内默认显示紧凑费用卡；宿主支持时提供“悬浮面板”（Picture-in-Picture）和“展开面板”（全屏）；全屏内提供概览、历史、模型、设置。
- 按每个 turn 的实际 provider/model 计费
- 基于 `thread_id + response_id` 去重，支持 fork/resume
- 预算金额/周期/自定义区间，以及 API 实际支出与 Plan 等值金额分离
- Plan provider/model 分类：命中后 API 支出为 0，仅记录订阅等值金额
- 余额与额度页：DeepSeek 官方余额、自定义 Provider 余额、Coding Plan、Gateway 多账号额度、SCNet/Qwen 本地 Credits；最近一次成功结果会缓存
- 支持阿里云/千问资金账户余额（通过自定义余额的 `adapter: aliyun`）
- 自定义价格、价格映射、官方价格同步。
- DSH ledger 历史导入与本地账本清除。
- 峰谷时段条与 30 秒倒计时；悬浮窗口可开启峰谷切换系统通知；会话费用排行。
- 紧凑预览卡显示当前 DeepSeek 峰谷时段、下一时段倒计时和官方剩余余额。
- 可见页面每 10 秒读取轻量状态并刷新费用；设置页编辑时暂停，峰谷倒计时仅显示到分钟。
- 余额缓存超过配置间隔时自动刷新，默认 30 秒；可选 15/30/60/120/300 秒。
- 设置页支持美元/人民币显示切换、汇率、预算、Plan 分类、官方余额、自定义价格、价格映射、DSH 导入、账本清除与高级余额 JSON 配置。
- 官方余额支持填写环境变量名或直接保存本地 Key；悬浮窗口“展开面板”会放大窗口而不会进入全屏。
- DSH 原有测试保持通过

## 当前边界

第一版已经能完成 Codex 本地 token、模型切换和 API 等价费用统计，以及核心 MCP Apps 面板。余额、Coding Plan、Gateway Quota 和 DSH 的完整设置页仍属于下一阶段；没有真实数据源的面板不会显示占位数据。

## 本地安装

仓库内已包含 repo marketplace：

```bash
codex plugin marketplace add /absolute/path/to/cost-meter-for-codex
codex plugin add cost-meter-for-codex@cost-meter-for-codex
```

安装后先执行 `/hooks`，信任 `Stop` 和 `SubagentStop` hook；未信任时费用查询仍可工作，但不会自动增量记账。

## 使用

- 查询本会话：`本会话 Codex 花了多少钱？`
- 查询今日：`今天 Codex 的 token 和费用`
- 打开面板：`打开 Codex 费用面板`

## 悬浮窗口

安装依赖后可启动独立置顶窗口。它不注入 Codex UI，但会浮在 Codex 上方：

```bash
pnpm install
node scripts/cost-meter.mjs float
```

窗口复用同一套 MCP Apps Web UI 和本地账本。Linux Wayland 下是否保持置顶取决于桌面环境；macOS 和 Windows 通常使用原生置顶能力。

`SessionStart` hook（startup / resume）会在 Codex 启动或恢复会话时自动拉起该窗口，`node scripts/cost-meter.mjs float` 幂等：检测到 `floating-window.pid` 对应的进程仍在运行就直接退出。关闭窗口后下次启动 Codex 会重新弹出。


## 排障：重启 Codex 后插件/悬浮窗消失

插件市场、插件启用和 hook 信任都存在 `~/.codex/config.toml`。桌面端在退出时会把内存里的副本写回该文件；如果注册是 Codex 正在运行时用 CLI 添加的，退出时可能被旧副本覆盖掉。

完全退出 Codex（托盘也退出）后，在系统终端重新注册一次，再启动 Codex：

```bash
codex plugin marketplace add "/home/amanyous/文档/ChatGPT/sardine/cost-meter-for-codex"
codex plugin add cost-meter-for-codex@cost-meter-for-codex
```

启动后在 Codex 里执行 `/hooks`，信任 `SessionStart` / `Stop` / `SubagentStop`，之后每次启动或恢复会话都会自动弹出悬浮窗。

> 插件安装目录使用 pnpm 虚拟存储（`node_modules/.package-map.json` + `.pnpm`），裸 `import('electron')` 解析不到依赖，因此 `float` 会回退到 `.pnpm/electron@*/node_modules/electron` 再启动。

## CLI

```bash
node scripts/cost-meter.mjs sync
node scripts/cost-meter.mjs status --json
node scripts/cost-meter.mjs status --thread <thread-id> --json
```

默认账本目录为 `$CODEX_HOME/cost-meter`；Codex 插件运行时使用 `PLUGIN_DATA`。

## 测试

```bash
npm run test:codex
npm test
```

`npm test` 在受限沙箱中可能需要允许回环监听，因为原 DSH 测试会启动本地探针服务。

余额示例：

```bash
node scripts/cost-meter.mjs config --set officialBalance.enabled=true --set officialBalance.apiKeyEnv=DEEPSEEK_API_KEY
node scripts/cost-meter.mjs config --set codingPlans.anthropic.enabled=true --set codingPlans.anthropic.apiKeyEnv=ANTHROPIC_OAUTH_TOKEN
node scripts/cost-meter.mjs balances refresh
node scripts/cost-meter.mjs balances --json
```

Gateway 与高级自定义配置可写入 `config.json` 的 `gatewaySources`、`customBalances`、`codingPlans` 和 `credentials`；密钥优先从环境变量读取。

```bash
```

预算示例：

```bash
node scripts/cost-meter.mjs config --set budget.amount=10 --set budget.period=monthly
node scripts/cost-meter.mjs config --set planProviders='["openai"]' --set planModels='["gpt-5.3-codex"]'
```

- 历史记录与模型页使用费用对比横条、模型标签和 API/Plan 分类条展示。
