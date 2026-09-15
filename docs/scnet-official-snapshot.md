# SCNet 外部控制台额度快照

从 1.7.17 起，启用 SCNet 额度显示后，插件优先读取当前账本目录下的 `scnet_official.json`，通常为 `$DSH_HOME/storages/cost-meter/scnet_official.json`。缺失或无效时继续使用本地账本估算。此功能只影响 SCNet 额度显示，不修改账本用量、费用、订阅配置或其他提供商的统计。

外部采集器需要由用户另外提供。本插件不登录 SCNet 控制台、不采集浏览器 Cookie，也不负责自动生成此文件。文件名沿用 PR #114；本地 JSON 无法证明数据来自官方，所以界面标记为“外部控制台快照”，并保留采集时间。

## 数据格式

以下数值仅用于说明格式，不代表当前账号数据。接入时必须使用真实采集值和采集时间。

```json
{
  "used": 24338.72,
  "total": 60000,
  "fetchedAt": "2026-09-08T12:00:00Z",
  "resetsAt": "2026-10-01T00:00:00+08:00"
}
```

| 字段 | 约束 |
| --- | --- |
| `used` | 必填 JSON 数字，有限且 ≥ 0。超过总额时保留真实数值，进度条最高 100%。 |
| `total` | 必填 JSON 数字，有限且 > 0。有效快照中的总额优先于本地估算配置。 |
| `fetchedAt` | 必填采集时间，ISO 时间需显式携带 `Z` 或时区偏移；也接受 Unix 毫秒数。兼容 `at` 别名，两个字段都有时优先 `fetchedAt`。不能使用文件修改时间或每次读取时的当前时间替代。 |
| `resetsAt` | 可选，已知的真实重置时间，格式同上。缺失或空字符串时不显示重置时间；不能把采集时间填在这里。 |

数值字符串、`null`、布尔值、非有限数值、损坏 JSON 和大于 16 KiB 的文件不会被采用。文件不需要包含 API Key、Cookie、账号身份等数据。

## 有效期、刷新与回退

- 采集时间不能晚于当前时间，也不能超过 24 小时；采集器应按实际需要更频繁更新。24 小时是本插件接受外部快照的最长时限，不是官方数据的实时性保证。
- 如果提供 `resetsAt`，时间必须晚于采集时间和当前时间，到期立即回退。
- 如果没有 `resetsAt`，插件按配置的订阅起始日（留空为自然月）检查采集时刻与当前时刻是否在同一周期；跨周期回退，界面仍不推算或展示官方重置时间。
- 每次状态组装和点击 SCNet 刷新时重新读取文件。点击刷新只重读已有文件，不会触发外部采集器或延长采集时间。
- 缺失、不可读、损坏、过期或跨周期时使用 `Credits (est.)` 本地估算。估算仅覆盖本地账本中的 SCNet 订阅渠道及抵扣表收录模型，不能覆盖其他工具的用量。支持的提供商 ID 为 `scnet`、`scnet-tokenplan`、`scnet-token-plan` 及对应 `llm-` 前缀，忽略大小写；明确分类为 API 的调用不计入，其他渠道的同名模型不计入。自定义渠道名不会仅凭模型名被自动识别成 SCNet。
- 快照文件应属于当前使用的 SCNet 账号和套餐。切换账号、套餐或订阅周期时同时替换或移除旧快照，插件不从文件内容鉴别账号归属。

建议采集器先将完整 JSON 写入同目录临时文件，再通过原子重命名替换 `scnet_official.json`，避免读到写入一半的内容。无效文件不会破坏账本，也不会使整个费用面板读取失败。

## English

Version 1.7.17 supports an external SCNet console snapshot at `$DSH_HOME/storages/cost-meter/scnet_official.json`, next to the active ledger. A valid snapshot overrides only the SCNet quota display; it does not add external usage to the local ledger or billing totals. The user supplies the collector separately. The plugin does not log in to the console or collect cookies, and labels the source as an **external console snapshot** rather than a live verified API response.

The example above is illustrative. Replace it with actual values: `used` and `total` must be finite JSON numbers (`used >= 0`, `total > 0`); `fetchedAt` is the capture time, as timezone-qualified ISO text or Unix milliseconds. Legacy `at` is accepted when `fetchedAt` is absent. Optional `resetsAt` is the actual reset time, never the capture time. Preserve the capture timestamp on repeated reads. Missing reset times remain undisplayed.

Files must be regular files of at most 16 KiB. Future timestamps and captures older than 24 hours are rejected. Explicit reset times must be in the future; otherwise the capture must belong to the current configured subscription period. Missing, unreadable, malformed, expired or out-of-period snapshots fall back to the existing local `Credits (est.)` estimate. The configured credit limit continues to control that fallback. A manual refresh rereads the file without running the external collector. Use a temporary file and an atomic rename when updating. Replace/remove the snapshot when switching accounts or plans; the plugin cannot verify account ownership from this file. No credentials are required in the snapshot.

Local estimates include supported models only on SCNet subscription providers: `scnet`, `scnet-tokenplan`, `scnet-token-plan`, and their `llm-` prefixed forms (case insensitive). Explicit API classifications and matching model names used through other providers are excluded. Custom provider names are not inferred from model names alone. External snapshot amounts remain independent of this local filter.
