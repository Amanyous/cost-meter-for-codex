# GPT-6 Astra 计价核验

核验日期：2026-09-11。模型：`gpt-6-astra`。

[OpenAI 官方模型页](https://developers.openai.com/api/docs/models/gpt-6-astra) 公布标准 API 费率；[OpenCode Zen 目录](https://opencode.ai/docs/zen) 的同名模型费率与其一致。金额单位均为美元 / 百万 token。

| 单次完整输入长度 | 未缓存输入 | 缓存读取 | 缓存写入 | 输出 |
|---|---:|---:|---:|---:|
| ≤272,000 token | 10 | 1 | 12.5 | 50 |
| >272,000 token | 20 | 2 | 25 | 75 |

长档按整次请求收费。宿主提供的 `input`、`cacheRead`、`cacheWrite` 是互斥 token 桶，三个桶之和决定输入长度；输出 token 不参与输入阈值。缓存写入使用独立费率，不能按缓存读取价收取。

价格条目使用可执行字段 `cacheWrite` 和 `longContext`，经服务端规范化、配置存储与计费执行保留。只有明确配置这两个字段的条目改变行为；旧价表没有缓存写费率时继续沿用原来的缓存命中价。

按请求入账后，再汇总日/会话费用。纯聚合 token 不能推断单次上下文长度，历史重算需要完整的逐次调用记录。`test/gpt-astra-pricing.mjs` 覆盖基础档、跨档边界、缓存导致跨档、真实账本、目录挂载、渠道自定义价与旧价兼容。

本条目为标准 API 费率。Batch/Flex、Fast 等服务档的折扣或倍率不自动推断，第三方渠道的自行定价以用户挂载的精确渠道价为准。
