import assert from 'node:assert/strict'
import { queryGatewayQuota, GATEWAY_MANAGEMENT_PATHS } from '../lib/gateway-quotas.js'

const source = { id: 'retry-test', type: 'cliproxyapi', baseURL: 'http://127.0.0.1:8317', enabled: true, display: 'both', includeProviders: ['claude'] }
const ctx = { get: () => ({ resolve: async () => ({ value: 'mock-management-key' }) }) }
const auth = { auth_files: [{ auth_index: 'test-auth', provider: 'claude' }] }
const envelope = { status_code: 200, body: JSON.stringify({ five_hour: { utilization: 42 } }) }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status })

for (const status of [408, 429, 500, 502, 503, 504]) {
  let calls = 0
  let discarded = 0
  const result = await queryGatewayQuota(ctx, source, { fetchImpl: async url => {
    if (new URL(url).pathname === GATEWAY_MANAGEMENT_PATHS.authFiles) return json(auth)
    calls++
    if (calls === 1) return new Response(new ReadableStream({ cancel() { discarded++ } }), { status })
    assert.equal(discarded, 1, '重试前已取消错误响应体')
    return json(envelope)
  } })
  assert.equal(calls, 2)
  assert.equal(result.accounts[0].windows[0].percent, 42)
}

for (const hop of ['management', 'api-outer', 'api-inner']) {
  for (const status of [401, 403, 503]) {
    let calls = 0
    const result = await queryGatewayQuota(ctx, source, { fetchImpl: async url => {
      if (hop !== 'management' && new URL(url).pathname === GATEWAY_MANAGEMENT_PATHS.authFiles) return json(auth)
      calls++
      return hop === 'api-inner' ? json({ status_code: status, body: '{}' }) : json({}, status)
    } })
    assert.equal(calls, status === 503 ? 2 : 1, `${hop} / ${status} 有界重试或立即拒绝`)
    assert.notEqual(result.status, 'ok')
  }
}
let malformedCalls = 0
const malformed = await queryGatewayQuota(ctx, source, { fetchImpl: async url => {
  if (new URL(url).pathname === GATEWAY_MANAGEMENT_PATHS.authFiles) return json(auth)
  malformedCalls++
  return json({ status_code: 200, body: 'invalid JSON' })
} })
assert.equal(malformedCalls, 1, '解析失败不重试')
assert.notEqual(malformed.status, 'ok')
console.log('[ok] 网关重试：暂态状态、耗尽、鉴权、畸形响应与连接释放回归通过')
