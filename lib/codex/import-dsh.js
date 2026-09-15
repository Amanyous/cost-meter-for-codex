import { readFileSync } from 'node:fs'
import { appendEvents, clearEvents, readEvents } from './ledger.js'

function atNoon(date) {
  const parsed = new Date(`${date}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? Date.now() : parsed.getTime()
}

function eventsForEntry(date, sessionId, key, bucket) {
  const separator = key.indexOf(':')
  const provider = separator > 0 ? key.slice(0, separator) : 'deepseek'
  const model = separator > 0 ? key.slice(separator + 1) : key
  const num = value => Math.max(0, Number(value) || 0)
  return {
    key: `dsh:${date}:${sessionId}:${key}`,
    threadId: sessionId,
    turnId: '',
    responseId: `dsh:${date}:${key}`,
    atMs: atNoon(date),
    cwd: null,
    source: 'dsh-ledger-import',
    isSubagent: false,
    callCount: Math.max(1, Number(bucket?.calls) || 1),
    provider,
    model,
    usage: {
      input: num(bucket?.input),
      output: num(bucket?.output),
      cacheRead: num(bucket?.cacheRead),
      cacheWrite: num(bucket?.cacheWrite),
      reasoning: num(bucket?.reasoning),
      total: num(bucket?.input) + num(bucket?.output) + num(bucket?.cacheRead) + num(bucket?.cacheWrite) + num(bucket?.reasoning),
    },
  }
}

export function dshLedgerEvents(ledger) {
  const events = []
  for (const [date, day] of Object.entries(ledger?.days || {})) {
    const sessions = Array.isArray(day?.sessions) ? day.sessions : []
    if (sessions.length > 0) {
      for (const session of sessions) {
        const buckets = session?.byProviderModel && Object.keys(session.byProviderModel).length > 0 ? session.byProviderModel : day?.byProviderModel || {}
        for (const [key, bucket] of Object.entries(buckets)) events.push(eventsForEntry(date, session.id || `dsh-${date}`, key, bucket))
      }
    } else {
      for (const [key, bucket] of Object.entries(day?.byProviderModel || {})) events.push(eventsForEntry(date, `dsh-${date}`, key, bucket))
    }
  }
  return events
}

export function importDshLedger(dataDir, ledgerPath) {
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
  const events = dshLedgerEvents(ledger)
  const result = appendEvents(dataDir, events)
  return { ...result, imported: events.length }
}

export function resetCodexLedger(dataDir) {
  clearEvents(dataDir)
  return { cleared: true, remaining: readEvents(dataDir).length }
}
