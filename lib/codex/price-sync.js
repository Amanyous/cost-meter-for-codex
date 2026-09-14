import { fetchWithRetry } from '../net.js'
import { OFFICIAL_PRICING_URL, OFFICIAL_PRICING_URL_ZH, parsePricingHtml } from '../pricing.js'

export async function syncOfficialPrices({ locale = 'en', fetchImpl = fetch } = {}) {
  const url = locale === 'en' ? OFFICIAL_PRICING_URL : OFFICIAL_PRICING_URL_ZH
  const response = await fetchWithRetry(url, {}, { fetchImpl, attempts: 2, timeoutMs: 15000 })
  if (!response.ok) throw new Error(`official pricing HTTP ${response.status}`)
  const html = await response.text()
  const parsed = parsePricingHtml(html)
  if (!parsed?.models || Object.keys(parsed.models).length === 0) throw new Error('official pricing page did not contain models')
  return {
    url,
    fetchedAt: new Date().toISOString(),
    currency: parsed.currency || 'CNY',
    models: parsed.models,
    peakWindows: parsed.peakWindows || [],
  }
}
