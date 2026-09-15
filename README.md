# cost-meter-for-codex

**Codex 版费用统计插件**：复用 [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) 的计价引擎，把「本会话 / 当日 / 历史费用、多模型价格目录与官方价格同步、官方余额与 Coding Plan 额度、峰谷计价时段」搬到 Codex 上，提供三种展示面：**对话内 MCP Apps 面板**、**桌面置顶悬浮窗**、**CLI**。

> **原项目**：[Han-1413141/dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter)（DeepSeek Harness 插件，MIT）。
> 本仓库是它的 **Codex 适配分支**：新增 `.codex-plugin/`、`.mcp.json`、`hooks/`、`mcp/`、`skills/`、`lib/codex/`、`src/codex-ui/`、`scripts/{cost-meter,floating-window}.mjs`，保留上游 `lib/`、`src/` 代码以便跟随上游更新。上游原版中文说明见 [README.dsh.md](README.dsh.md)，英文说明见 [README.en.md](README.en.md)。

## 已测试平台

| 平台 | 状态 |
|---|---|
| **Linux** — Ubuntu 26.04.1 LTS，Node v24.14.0，codex-cli 0.154.0（X11 桌面） | ✅ 已实测：hooks 自动记账、对话内 MCP Apps 面板、置顶悬浮窗、余额与价格同步、历史 / 模型 / 会话页、峰谷进度 |
| macOS | ❌ 未测试（代码已按平台分支处理：置顶层级、全屏空间、workarea 定位） |
| Windows | ❌ 未测试（代码已按平台分支处理：`windowsHide`、路径与置顶调用） |
| Codex IDE / Cloud / remote | 暂不支持 |

> Linux 只验证过 **X11**；Wayland 下「置顶」由桌面环境决定，可能不生效。

## 已知问题（Bug / 限制）

1. **插件注册会被桌面端覆盖（影响最大）**
   插件市场、插件启用、feature 开关、hook 信任都写在 `~/.codex/config.toml`。Codex 桌面端退出时会用**内存里的旧副本**回写该文件；如果注册是在 Codex 运行期间用 CLI 添加的，重启后可能被抹掉。表现：重启后悬浮窗不再自动弹出、不再自动记账、`enable_mcp_apps` 变回 `false`、对话内面板无法加载。
   修复：**完全退出 Codex（含托盘）后**，在系统终端执行一次：
   ```bash
   codex plugin marketplace add "/绝对路径/cost-meter-for-codex"
   codex plugin add cost-meter-for-codex@cost-meter-for-codex
   codex features enable enable_mcp_apps
   codex features enable mcp_2026_07_28
   ```
   然后启动 Codex，执行 `/hooks` 信任 `SessionStart` / `Stop` / `SubagentStop`。详见 [排障说明](docs/codex-plugin.md)。
2. **悬浮窗依赖 Electron**：`electron` 是运行期依赖（首次安装需下载 ~100MB，安装后约 280MB）。插件安装目录是 pnpm 虚拟存储，`float` 已做解析回退（`.pnpm/electron@*/node_modules/electron`），但 Electron 未装好时窗口起不来——面板与 CLI 仍可用。
3. **hooks 需要手动信任**：未信任时不自动记账、不自动弹窗（手动查询与面板仍可用）。
4. **对话内面板依赖两个 under-development feature**：`enable_mcp_apps` 与 `mcp_2026_07_28`。它们是 Codex 的实验开关，升级 Codex 或配置被覆盖后需要重新 enable。
5. **金额是 API 等价估算**：订阅套餐不暴露单次调用金额，统计的是按公开价目表折算的等价费用。官方余额接口返回的数值与官网展示口径可能不同（官网含赠送 / 充值的拆分），以官网为准。
6. **峰谷通知**依赖系统通知（Linux 需 libnotify / 通知守护进程），Wayland 下置顶与通知行为可能不一致。
7. **不做多机同步**：账本为本机 JSONL（`~/.codex/cost-meter/usage.jsonl`），只统计本机已产生的 Codex 会话。
8. **上游 DSH 侧功能未逐一回归**：侧边栏 UI、输入框横条等 DSH 专有展示面在 Codex 上不存在，本仓库只移植了可在 Codex 落地的部分（面板 / 悬浮窗 / CLI / hooks）。

## 功能

| 能力 | 说明 |
|---|---|
| 会话与历史费用 | 本会话、今日、全部历史；按 turn 记账，去重（thread + response），支持子代理、fork / resume 会话 |
| 计价 | 内置 90+ 模型价格目录 + 按模型 / 供应商自动匹配 + 自定义价格与覆盖 + 官方价格一键同步 |
| Plan / API 双轨 | 订阅额度与按量金额分开统计（`planProviders` / `planModels` 可配） |
| 余额与额度 | 官方 DeepSeek 余额、自定义 Provider 余额（任意 HTTP 端点）、9 家 Coding Plan（Anthropic / Z.ai / MiniMax / Kimi / OpenRouter / SiliconFlow / CommandCode / SCNet / 火山方舟）、网关额度、SCNet / 千问本地 Credits |
| 峰谷时段 | 峰 / 谷进度条与百分比、下一时段倒计时（不含秒）、切换通知与提醒 |
| 预算 | 日 / 周 / 月 / 自定义预算，USD 记账、CNY / USD 双币种显示（含汇率） |
| 页面 | 概览 / 额度 / 历史 / 模型 / 会话 / 设置；10 秒轻量轮询（只读账本，不重复解析日志）自动刷新，余额默认 30 秒 |
| 展示面 | ① 对话内 MCP Apps 面板（`render_cost_dashboard`）② Electron 置顶悬浮窗（390×430，可展开 760×700，响应式）③ CLI |

## 安装（Codex 插件）

```bash
# 1) 注册本地插件市场并安装（路径换成你的仓库绝对路径）
codex plugin marketplace add "/绝对路径/cost-meter-for-codex"
codex plugin add cost-meter-for-codex@cost-meter-for-codex

# 2) 打开对话内面板需要的两个 feature
codex features enable enable_mcp_apps
codex features enable mcp_2026_07_28
```

在 Codex 里执行 `/hooks`，信任 `SessionStart`（startup + resume）、`Stop`、`SubagentStop`。之后：

- 每个 turn 结束自动记账；
- 启动 / 恢复会话时自动拉起悬浮窗（幂等，已在运行会跳过）。

> 首次在源码仓库开发时还需要 `pnpm install`（会下载 Electron）。

## 使用

| 场景 | 做法 |
|---|---|
| 对话内面板 | 输入 `$cost-meter-for-codex:cost-meter 打开费用面板`，或直接问「本会话花了多少钱」 |
| 悬浮窗 | `node scripts/cost-meter.mjs float`（重复执行直接退出）；关掉后下次启动 Codex 自动弹 |
| 状态查询 | `node scripts/cost-meter.mjs status --json`（可加 `--thread <id>`、`--scope session/today/all`） |
| 配置 | `node scripts/cost-meter.mjs config --set currency=CNY --set exchangeRate=7.2` |

CLI 子命令：`sync` · `status` · `config` · `balances` · `float` · `import-dsh` · `reset` · `sync-prices`。

## 数据与配置

默认目录 `$CODEX_HOME/cost-meter`（可用 `COST_METER_DATA_DIR` 覆盖）：

| 文件 | 内容 |
|---|---|
| `usage.jsonl` | 追加式账本，每条 turn 的 token / 费用 / 模型 / 来源 |
| `config.json` | 币种、汇率、预算、峰谷开关、余额与额度凭据、刷新间隔等 |
| `balances.json` | 最近一次成功拉取的余额快照（失败时保留旧值） |
| `floating-window.pid` | 悬浮窗进程号，用于幂等启动 |
| `active-session.json` | 当前活动会话与 transcript 分片指针 |

## 开发与测试

```bash
npm run test:codex   # Codex 侧：UI 构建 + 会话解析/账本 + MCP server
npm test             # 上游 DSH 测试套件（需要本地回环网络）
npm run build:codex-ui
```

代码结构：

```
.codex-plugin/plugin.json   Codex 插件清单
.mcp.json                   MCP server 声明（stdio）
hooks/                      SessionStart / Stop / SubagentStop
mcp/server.mjs              MCP 工具与 UI 资源
lib/codex/                  账本、会话解析、计价、余额、价格同步
src/codex-ui/               面板源码（构建产物 lib/codex-ui.html）
scripts/cost-meter.mjs      CLI（含 float 幂等启动）
scripts/floating-window.mjs Electron 置顶悬浮窗
skills/cost-meter/SKILL.md  Skill 说明
docs/codex-plugin.md        Codex 适配安装与排障
docs/codex-adaptation-plan.md 适配规划
```

## 许可

MIT。上游 [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) 版权归原作者所有。
