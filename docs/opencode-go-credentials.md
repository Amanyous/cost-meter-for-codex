# OpenCode Go 凭据发现

1.7.24 起，模型设置里指向 `https://opencode.ai/zen/go/v1` 的路由可使用任意名称。例如 `opencodego` 使用 `OPENCODEGO_API_KEY`，插件会读取该路由的 `apiKeyEnv`，无需修改凭据文件或重建路由。端点允许末尾 `/`。

额度查询与「已配置」状态使用相同候选顺序：

1. 专用引用 `OPENCODE_GO_API_KEY`。
2. DSH `llm-pi-ai.providers` 中匹配官方 Go 端点的路由引用，按配置顺序尝试并去重。
3. 兼容引用 `OPENCODE_API_KEY`。
4. opencode CLI 的 `auth.json` 登录态。
5. 迁移尚未完成时的插件旧配置兜底。

每个引用先查 DSH 凭据库，再查同名环境变量。路由名称、引用或 Key 更新后，下一次手动或定时刷新读取最新配置。多个 Go 账户同时存在时，使用首个可解析的引用；要指定额度所用账户，可在「费用 → 显示」保存专用 Go Key。解析到 Key 后若接口拒绝认证，不会轮流向接口试其他账户。

「保存 / 清除」只操作 `OPENCODE_GO_API_KEY`，不会改动或删除模型路由共享的 Key。清除专用 Key 后，若路由或 CLI 中仍有有效凭据，额度仍可查询；关闭额度查询请使用「启用」开关。

只有官方 HTTPS Go 端点参与自动发现。OpenCode Zen 的 `/zen/v1`、代理地址、非标准端口及相似域名不参与；需要查询 Go 额度时，可另外保存 Go 订阅专用 Key。插件始终请求固定的官方额度端点，不按模型路由更换请求地址。

若仍提示未找到 Key，请确认实际安装版本、路由端点与 `apiKeyEnv` 引用，并在模型设置中重新保存该路由的凭据。不要把 Key、凭据文件内容或完整请求头贴到 issue 中。

## English

Starting with 1.7.24, Go quota lookup reads `apiKeyEnv` from DSH `llm-pi-ai.providers` routes targeting `https://opencode.ai/zen/go/v1` (optional trailing slash), regardless of route name.

Priority: dedicated `OPENCODE_GO_API_KEY`, matching route refs in configuration order, legacy `OPENCODE_API_KEY`, opencode CLI login, then unmigrated legacy configuration. Each ref checks DSH credentials before its environment variable. Refreshing uses the current route configuration.

Saving or clearing the Go key affects only the dedicated ref. Shared model credentials remain available as a fallback. With multiple accounts, save a dedicated Go key to select the account; authentication failures do not trigger retries with other accounts. Zen and proxy endpoints are excluded from discovery. Credential values are never returned to the browser or written into the ledger.
