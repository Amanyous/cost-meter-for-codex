import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import readline from 'node:readline'

const toInt = value => {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

/**
 * Convert one Codex token_usage_record into the mutually-exclusive buckets
 * expected by lib/pricing.js. Codex reports input_tokens including cached
 * input; cache-write accounting has varied across releases, so only subtract
 * it from input when total_tokens proves it was included there.
 */
export function normalizeTokenUsage(raw = {}) {
  const inputTotal = toInt(raw.input_tokens ?? raw.inputTokens)
  const cacheRead = toInt(raw.cached_input_tokens ?? raw.cachedInputTokens)
  const cacheWriteRaw = toInt(raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens)
  const output = toInt(raw.output_tokens ?? raw.outputTokens)
  const reasoning = toInt(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens)
  const total = toInt(raw.total_tokens ?? raw.totalTokens)
  const cacheWriteSeparate = cacheWriteRaw > 0 && total >= inputTotal + output + cacheWriteRaw - 2
  const input = Math.max(0, inputTotal - cacheRead - (cacheWriteSeparate ? 0 : cacheWriteRaw))
  return {
    input,
    output,
    cacheRead,
    cacheWrite: cacheWriteRaw,
    reasoning,
    total: total || inputTotal + output,
    raw: {
      inputTokens: inputTotal,
      cachedInputTokens: cacheRead,
      cacheWriteInputTokens: cacheWriteRaw,
      outputTokens: output,
      reasoningOutputTokens: reasoning,
      totalTokens: total,
    },
  }
}

function responseKey(threadId, turnId, responseId, ordinal) {
  const stable = responseId || `${turnId || 'turn'}:${ordinal}`
  return `${threadId || 'thread'}:${stable}`
}

/** Pure parser used by tests and by the streaming file reader. */
export function eventsFromRecords(records, filePath = '') {
  let meta = {}
  let lastContext = null
  const turnContexts = new Map()
  const events = []

  records.forEach((record, index) => {
    const payload = record?.payload ?? {}
    if (record?.type === 'session_meta') {
      meta = payload
      if (typeof payload.model === 'string') {
        lastContext = { model: payload.model, provider: payload.model_provider, cwd: payload.cwd }
      }
      return
    }
    if (record?.type === 'turn_context') {
      const context = {
        model: payload.model,
        provider: payload.model_provider,
        cwd: payload.cwd,
      }
      lastContext = context
      if (payload.turn_id) turnContexts.set(payload.turn_id, context)
      return
    }
    if (record?.type !== 'token_usage_record') return

    const context = turnContexts.get(payload.turn_id) ?? lastContext ?? {
      model: meta.model,
      provider: meta.model_provider,
      cwd: meta.cwd,
    }
    const threadId = payload.thread_id || payload.session_id || meta.id || meta.session_id || 'thread'
    const responseId = payload.response_id
    const turnId = payload.turn_id
    const atMs = Date.parse(record.timestamp) || Number(payload.completed_at_ms) || Date.now()
    events.push({
      key: responseKey(threadId, turnId, responseId, record.ordinal ?? index),
      threadId,
      turnId,
      responseId,
      atMs,
      cwd: context.cwd || meta.cwd || null,
      provider: context.provider || meta.model_provider || 'unknown',
      model: context.model || meta.model || 'unknown',
      source: filePath,
      isSubagent: Boolean(meta.source?.subagent || /subagent|guardian/i.test(String(meta.thread_source || ''))),
      usage: normalizeTokenUsage(payload.usage ?? payload),
    })
  })

  return {
    meta: {
      sessionId: meta.id || meta.session_id || null,
      parentThreadId: meta.parent_thread_id || null,
      cwd: meta.cwd || null,
      modelProvider: meta.model_provider || null,
      threadSource: meta.thread_source || null,
      source: filePath,
    },
    events,
  }
}

export function parseJsonLines(text, filePath = '') {
  const records = []
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // A torn final line is common while Codex is still writing. Skip it.
    }
  }
  return eventsFromRecords(records, filePath)
}

export async function readRolloutEvents(filePath) {
  const records = []
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let index = 0
  for await (const line of lines) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line)
      record.ordinal ??= index
      records.push(record)
    } catch {
      // Ignore torn lines; a later sync will pick up completed records.
    }
    index += 1
  }
  return eventsFromRecords(records, filePath)
}

export async function listRolloutFiles(root) {
  const files = []
  async function walk(directory) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    }
  }
  await walk(root)
  return files.sort()
}
