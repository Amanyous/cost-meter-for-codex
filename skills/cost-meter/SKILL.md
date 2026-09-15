---
name: cost-meter
description: Query Codex local session token usage and API-equivalent cost, or render the Codex Cost Meter dashboard. Use when the user asks about Codex cost, token usage, model spend, history, or wants to view the cost dashboard.
---

# Codex Cost Meter

Use the `cost-meter` MCP tools instead of estimating from the conversation.

- Call `cost_status` for a textual summary. Use `scope: "session"` for the current conversation, `"today"` for the local day, or `"all"` for history.
- Call `render_cost_dashboard` when the user asks to see, open, or render the cost UI. First get a fresh snapshot with `cost_status`, then pass it as `snapshot`.
- Use `includeSubagents: false` only when the user explicitly wants parent sessions only.
- Do not call the tools on every turn. Use them when the user asks about cost or when showing cost is directly relevant.
- Report the result as an API-equivalent estimate. Subscription plans do not expose a per-call cash price.
