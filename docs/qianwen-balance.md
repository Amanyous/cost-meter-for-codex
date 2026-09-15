# 千问 / 阿里云余额

在「设置 → 费用 → 额度 → 自定义 Provider 余额」点击「添加千问 / 阿里云余额」，展开配置后填写 RAM AccessKey ID 和 AccessKey Secret，再启用条目。显示位置和刷新间隔沿用余额卡片设置。

- 查询阿里云中国站资金账户的 `AvailableAmount`，币种取自响应 `Currency`。这是账户可用金，可能受信控额度和未结清款影响，不等同于现金余额 `CashAmount`，也不是千问 Token Plan 订阅额度。仅关联该阿里云资金账户的千问用量适用；其他资金账户不在此次查询范围内。
- RAM 最小权限为 `bss:DescribeBillingAccount`，资源为 `*`。默认不传 `FundAccountId`，查询凭据所属账号的默认资金账户。
- AccessKey 不是千问模型调用 API Key。密钥通过只写输入框存入 DSH 凭据库；也可使用环境变量 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`。STS 临时凭据额外填写 `ALIBABA_CLOUD_SECURITY_TOKEN`；长期 AccessKey 留空此项。所有阿里云余额条目共享这一组凭据。
- 请求固定发往 `https://business.aliyuncs.com/`，使用 `GetFundAccountAvailableAmount`（版本 `2023-09-30`）及 ACS3-HMAC-SHA256 签名。配置中的通用请求 URL、请求头和 extract 不覆盖此适配器。AccessKey Secret 不作为请求字段发送，重定向直接拒绝。
- 未配置凭据时显示配置提示；鉴权、响应格式或金额字段错误时显示失败，不把查询失败记为零余额。余额查询不产生调用用量，不修改账本金额。

接口字段和 RAM 权限见[阿里云 API 文档](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2023-09-30-getfundaccountavailableamount)；请求方法与端点依据[官方 TypeScript SDK](https://github.com/aliyun/alibabacloud-typescript-sdk/blob/master/bssopenapi-20230930/src/client.ts)，签名依据[官方 ACS3 规范](https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature)。

## English

Open **Settings → Cost → Quota → Custom provider balance**, click **Add Qianwen / Alibaba Cloud balance**, expand the entry, save your RAM AccessKey ID and AccessKey Secret, then enable it. Choose the display location and refresh interval as for other balance cards.

- The card queries `AvailableAmount` for an Alibaba Cloud China fund account and uses the returned `Currency`. Available funds can include credit and unsettled charges; they differ from `CashAmount` and Qianwen Token Plan quota. Only Qianwen usage linked to this fund account is covered.
- Grant RAM action `bss:DescribeBillingAccount` on resource `*`. No `FundAccountId` is sent; the API selects the caller's default fund account.
- Use RAM AccessKey credentials, not a Qianwen model API key. The write-only fields store credentials in DSH. Environment variables are also supported: `ALIBABA_CLOUD_ACCESS_KEY_ID`, `ALIBABA_CLOUD_ACCESS_KEY_SECRET`, and, for temporary STS credentials only, `ALIBABA_CLOUD_SECURITY_TOKEN`. All Alibaba Cloud balance entries share these credentials.
- Requests use the fixed China endpoint `https://business.aliyuncs.com/`, API `GetFundAccountAvailableAmount` version `2023-09-30`, and ACS3-HMAC-SHA256 signing. Generic URL/header/extract settings do not override this adapter. The secret is never sent as a request field; redirects are refused.
- Missing credentials show a setup hint. Authentication and malformed responses show an error rather than a zero balance. Queries do not add usage or change ledger costs.

The implementation is covered by signature fixtures, mock HTTP responses, credential/RPC integration tests and client component interaction tests. Verification did not use a live Alibaba Cloud account.
