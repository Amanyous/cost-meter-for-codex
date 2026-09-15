# 宿主兼容验证：dsh-cost-meter 1.7.14

验证日期：2026-09-08。环境：Windows、Node.js 24.19.0；每个宿主使用独立安装目录和 `DSH_HOME`，不修改用户当前 DSH 配置。

| 官方 DSH 版本 | 安装与启动 | 宿主模块复用 | 隔离服务计费 | 卸载与数据保留 | 声明 |
| --- | --- | --- | --- | --- | --- |
| 0.1.2-rc.1 | 通过 | 通过 | 3 次 / 300 输入 tokens | 通过 | compatible |
| 0.1.3-alpha.1 | 官方 npm 无此版本，GitHub Release 无安装资产 | 未测 | 未测 | 未测 | unknown |
| 0.1.3-alpha.2 | 通过 | 通过 | 3 次 / 300 输入 tokens | 通过 | compatible |

“compatible”表示下述插件链路在此环境通过，不代表已测试所有宿主功能或所有操作系统。历史 alpha.3/4/5 声明沿用之前记录，本次未重测。没有运行 DSH Desktop 整个桌面外壳。

## 本次确认的行为

- 从本地 npm 包使用宿主 `plugin --profile web add` 安装，`--dump-config` 中仅出现一条插件配置；Web 正常启动并加载插件。
- 插件解析到的 `@deepseek-ai/dsh-credentials` 与 `@deepseek-ai/dsh-home-paths` 路径，经 `realpath` 后分别等于宿主解析到的同一个模块文件。两个宿主包作为 peer dependency 复用，独立运行依赖 `zod` 保持精确锁版。
- 探针通过真实 Cordis 隔离的 `llm/stream` 发送主会话、子会话、无会话三条**合成 usage**，每条输入 100、输出 20 tokens。日调用数增加 3，输入增加 300；没有发起模型请求。独立回归另外检查父子会话分别入账、无会话调用仅入总计，普通非全局监听器作为对照只收到主会话调用。
- alpha.2 的实际 Web 页面验证了千问空费率行可编辑、三项填齐自动保存、刷新后仍为 12.5 / 1.5 / 30；未知模型移除后刷新不重现，恢复后重新显示，调用数保持不变。检查了紧凑样式配置、侧边栏卡片和收起后的百分比入口。
- 停止宿主后卸载：插件配置与 Profile 中的包均移除，`storages/cost-meter/ledger.json` 保留。

## 复现

在仓库根目录打开一次性 PowerShell 终端。先运行 `pnpm install --frozen-lockfile`、`node scripts/build.mjs` 和 `node test/verify.mjs`。以下示例使用 alpha.2；将 `$cmVersion` 替换为 `0.1.2-rc.1` 可复查另一版本。

```powershell
$cmRepo = (Get-Location).Path
$cmVersion = '0.1.3-alpha.2'
$cmRoot = Join-Path $cmRepo '.tmp-compat-repro'
$cmHost = Join-Path $cmRoot "host-$cmVersion"
$env:DSH_HOME = Join-Path $cmRoot "home-$cmVersion"
New-Item -ItemType Directory -Force -Path $cmRoot | Out-Null
npm install --prefix $cmHost "@deepseek-ai/dsh@$cmVersion" --no-fund --no-audit
npm pack --pack-destination $cmRoot
$cmCli = Join-Path $cmHost 'node_modules/@deepseek-ai/dsh/lib/bin.js'
$env:CM_HOST_PACKAGE = Join-Path $cmHost 'node_modules/@deepseek-ai/dsh/package.json'
node $cmCli plugin --profile web add (Join-Path $cmRoot 'dsh-cost-meter-1.7.14.tgz')
node $cmCli --profile web --dump-config

# 仅清除本终端进程中的凭据变量，不改变用户级/系统级环境变量。
Get-ChildItem Env: | Where-Object Name -Match 'API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY' |
  ForEach-Object { Remove-Item -LiteralPath "Env:$($_.Name)" }
$cmEntry = Join-Path $cmRepo 'test/fixtures/host-compatibility-probe/index.mjs'
$cmUrl = node -e "process.stdout.write(require('node:url').pathToFileURL(process.argv[1]).href)" $cmEntry
$cmPatch = Join-Path $cmRoot 'probe.patch.yml'
@("- insert:", "    - id: cost-meter-compatibility-probe", "      name: '$cmUrl'") |
  Set-Content -LiteralPath $cmPatch -Encoding utf8
node $cmCli --profile web --patch $cmPatch --no-open --host 127.0.0.1 --port 3991
```

看到 `[cm-compatibility-probe]` 中 `passed: true` 和 Web 启动成功后，用 Ctrl+C 停止；探针结果保存在 `$DSH_HOME/compatibility-probe.json`。通过终端给出的本机登录地址可检查 UI。随后执行：

```powershell
node $cmCli plugin --profile web remove dsh-cost-meter
node $cmCli --profile web --dump-config
Test-Path (Join-Path $env:DSH_HOME 'profiles/web/node_modules/dsh-cost-meter') # False
Test-Path (Join-Path $env:DSH_HOME 'storages/cost-meter/ledger.json')          # True
```

探针限制 `DSH_HOME` 必须位于本仓库 `.tmp-compat-*` 目录。它修改测试配置、写入合成账本记录，不应加载到日常使用的 Profile。每次重跑按前后差值断言，不要求清空账本。

## 商店状态与验证边界

此次处理时，DSH STORE Catalog 仍引用插件 1.7.13，并因官方最新三个宿主版本均缺少精确的 `compatible` 记录而显示 `unlisted`。1.7.14 增加两个已测版本记录；alpha.1 保留 `unknown`。是否重新上架，以商店对新固定 commit 的复检结果为准，历史修复单关闭不等于当前已上架。

- [官方 alpha.1 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)
- [DSH STORE 原适配单 #239](https://github.com/AI-Scarlett/DSH-Store/issues/239)
- [插件依赖预检问题 #106](https://github.com/Han-1413141/dsh-cost-meter/issues/106)

子代理覆盖范围限于宿主上报的 usage。插件自行 `fetch` 外部 API 且不向宿主报告用量的调用不在统计范围内；本次没有用真实账号验证任何指定记忆插件的外部账单。
