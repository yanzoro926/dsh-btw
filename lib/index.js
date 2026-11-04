/**
 * dsh-btw — host half.
 *
 * The plugin answers a one-off side question ("by the way") from the current
 * conversation. It follows ds-bot 0.2.4's `src/host/btw.js`: snapshot the live
 * session with requestHeader() + trimToolBoundary(deriveMessages()) +
 * toolHistory(), make ONE `ctx.llm.stream()` call, and stream the answer back
 * over a plugin-owned SSE route. No Agent is created and no Session event is
 * written, so the answer never enters that conversation's memory.
 *
 * Routes:
 *   GET  /btw/health   — liveness + resolved config (for the client's diagnostics)
 *   POST /btw/context  — context preview: range → {stats, dropped, cold}
 *   POST /btw/ask      — JSON in, text/event-stream out; request admission is
 *                        consulted through ctx.connection.requestRejection.
 *
 * The route is unauthenticated by the web server itself, which is why every
 * request goes through the fence first: on loopback any local process could
 * otherwise spend the user's model quota.
 */
import { randomUUID } from 'node:crypto'

import {
  DEFAULT_CONFIG,
  FOCUS_MAX_CHARS,
  buildBtwMessages,
  buildInjectionBody,
  buildSummaryPrompt,
  cleanSummary,
  fallbackSummary,
  foldEventsToSnapshot,
  mapFailure,
  messageOf,
  messageQuote,
  normaliseDialogMessages,
  normalisePriorTurns,
  normaliseRange,
  normaliseSummaryMeta,
  pickSession,
  previewContext,
  snapshotOf,
  sseFrame,
} from './logic.js'

export const name = 'dsh-btw-plugin'

export const VERSION = '0.5.6'

// All are real host services in DSH 0.2.1-rc.5 (see ds-bot's and
// dsh-better-sidebar's inject lists). A missing service only delays apply().
export const inject = ['webServer', 'llm', 'sessions', 'connection']

export function apply(ctx, config = {}) {
  try {
    const cfg = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) }
    if (cfg.enabled === false) return

    const register = (path, handler, label) => {
      try {
        ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }), label)
      } catch (error) {
        // A route conflict must fail only this plugin row, never host startup.
        try { ctx.logger?.warn?.('dsh-btw: cannot register %s', path, error) } catch { /* no logger */ }
      }
    }

    register('/btw/health', (req, res) => handleHealth(ctx, cfg, req, res), 'dsh-btw: /btw/health')
    register('/btw/models', (req, res) => handleModels(ctx, cfg, req, res), 'dsh-btw: /btw/models')
    register('/btw/context', (req, res) => handleContext(ctx, cfg, req, res), 'dsh-btw: /btw/context')
    register('/btw/ask', (req, res) => handleAsk(ctx, cfg, req, res), 'dsh-btw: /btw/ask')
    register('/btw/summarize', (req, res) => handleSummarize(ctx, cfg, req, res), 'dsh-btw: /btw/summarize')
    register('/btw/commit', (req, res) => handleCommit(ctx, cfg, req, res), 'dsh-btw: /btw/commit')
  } catch (error) {
    try { ctx.logger?.warn?.('dsh-btw: activation failed', error) } catch { /* no logger */ }
  }
}

/* ------------------------------------------------------------------ routes */

function handleHealth(ctx, cfg, req, res) {
  if (!fence(ctx, req, res)) return
  if (req.method !== 'GET') return writeJson(res, 405, failure('METHOD_NOT_ALLOWED', 'GET only'))
  writeJson(res, 200, {
    ok: true,
    plugin: name,
    version: VERSION,
    coldRead: coldReadKind(ctx),
    defaultRoute: defaultRoute(ctx),
    config: {
      maxParentMessages: cfg.maxParentMessages,
      maxRangeMessages: cfg.maxRangeMessages,
      defaultRecentMessages: cfg.defaultRecentMessages,
      maxPriorTurns: cfg.maxPriorTurns,
      maxSummaryChars: cfg.maxSummaryChars,
      toolParity: cfg.toolParity === true,
    },
  })
}

/* --------------------------------------------------------------- model list */

const MODEL_CACHE_TTL_MS = 60_000
const MODEL_LIST_TIMEOUT_MS = 2_500
let modelCache = { at: 0, providers: [] }

/** GET /btw/models — provider/model catalog for the btw picker. */
async function handleModels(ctx, cfg, req, res) {
  if (!fence(ctx, req, res)) return
  if (req.method !== 'GET') return writeJson(res, 405, failure('METHOD_NOT_ALLOWED', 'GET only'))

  let sessionId = ''
  try {
    const url = new URL(req.url || '/', 'http://localhost')
    sessionId = pickString(url.searchParams.get('sessionId')) ?? ''
  } catch { /* keep the global catalog */ }

  const providers = await modelCatalog(ctx)
  let current = null
  if (sessionId) {
    const session = pickSession(ctx, sessionId)
    if (session) {
      try {
        const config = headerConfigOf({ header: session.requestHeader() })
        if (pickString(config.provider) && pickString(config.model)) {
          current = { provider: config.provider, model: config.model }
        }
      } catch { /* the session has no resolved route yet */ }
    }
  }
  const fallback = defaultRoute(ctx)
  // Catalog-driven adapters may report no models (the base adapter returns an
  // empty list). Keep the two routes the harness itself knows about selectable.
  ensureRoute(providers, current)
  ensureRoute(providers, fallback)
  writeJson(res, 200, { ok: true, providers, default: fallback, current })
}

/** Add a provider/model pair to the catalog when the adapter did not list it. */
function ensureRoute(providers, route) {
  if (!route || !pickString(route.provider) || !pickString(route.model)) return
  let entry = providers.find((provider) => provider.id === route.provider)
  if (!entry) {
    entry = { id: route.provider, name: route.provider, models: [] }
    providers.push(entry)
  }
  if (!entry.models.some((model) => model.id === route.model)) {
    entry.models.push({ id: route.model, name: route.model })
  }
}

async function modelCatalog(ctx) {
  const now = Date.now()
  if (now - modelCache.at < MODEL_CACHE_TTL_MS && modelCache.providers.length > 0) {
    return modelCache.providers
  }
  const llm = serviceOf(ctx, 'llm') || ctx.llm
  let listed = []
  try {
    listed = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  } catch { /* registry unavailable: return an empty catalog */ }

  const providers = await Promise.all((Array.isArray(listed) ? listed : []).map(async (provider) => {
    if (!provider || !pickString(provider.id)) return null
    const entry = { id: provider.id, name: provider.name || provider.id, models: [] }
    if (typeof llm?.listModels !== 'function') return entry
    try {
      // Some adapters probe the network here; never let one slow provider hang
      // the whole picker (the dialog would otherwise show "读取模型…" forever).
      const models = await withTimeout(llm.listModels(provider.id), MODEL_LIST_TIMEOUT_MS)
      entry.models = (Array.isArray(models) ? models : [])
        .filter((model) => model && pickString(model.id))
        .map((model) => ({
          id: model.id,
          name: model.name || model.id,
          ...(pickString(model.description) ? { description: model.description } : {}),
        }))
    } catch (error) {
      entry.error = messageOf(error)
    }
    return entry
  }))
  const catalog = providers.filter(Boolean)
  // Do not cache an empty catalog: the first request may race provider mounts.
  if (catalog.length > 0) modelCache = { at: now, providers: catalog }
  return catalog
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/** The harness-wide default model selection, when that service is present. */
function defaultRoute(ctx) {
  try {
    const selection = serviceOf(ctx, 'agentDefaultModel')?.currentSelection?.()
    if (selection && pickString(selection.provider) && pickString(selection.model)) {
      return { provider: selection.provider, model: selection.model }
    }
  } catch { /* optional service */ }
  return null
}

/**
 * Turn a client focus hint into an inlined quote. A message focus is resolved
 * against the full (pre-range) snapshot, so the quote still works when the
 * selected range would drop that message. Unknown ids are ignored instead of
 * failing the whole ask.
 */
function normaliseFocus(raw, snapshotMessages) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.kind === 'selection') {
    const text = pickString(raw.text)
    if (!text || !text.trim()) return null
    return { kind: 'selection', text: text.trim().slice(0, FOCUS_MAX_CHARS), role: null }
  }
  if (raw.kind === 'message') {
    const id = pickString(raw.messageId)
    if (!id || !Array.isArray(snapshotMessages)) return null
    const message = snapshotMessages.find((candidate) => candidate && candidate.id === id)
    if (!message) return null
    const text = messageQuote(message, FOCUS_MAX_CHARS)
    if (!text) return null
    return { kind: 'message', text, role: pickString(message.role) ?? null }
  }
  return null
}

/** POST /btw/context — how much history would be sent for a given range. */
async function handleContext(ctx, cfg, req, res) {
  if (!fence(ctx, req, res)) return
  if (req.method !== 'POST') return writeJson(res, 405, failure('METHOD_NOT_ALLOWED', 'POST only'))

  let payload
  try {
    payload = await readJsonBody(req, cfg.maxBodyBytes)
  } catch (error) {
    return writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400,
      failure('BAD_REQUEST', messageOf(error)))
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return writeJson(res, 400, failure('BAD_REQUEST', 'JSON object body expected'))
  }

  const sessionId = pickString(payload.sessionId) ? payload.sessionId.trim() : ''
  if (!sessionId) return writeJson(res, 400, failure('BAD_REQUEST', 'sessionId is required'))
  const range = normaliseRange(payload.range, cfg)

  let snapshot
  try {
    snapshot = await resolveSnapshot(ctx, sessionId, cfg)
  } catch (error) {
    const coldUnavailable = error?.code === 'SESSION_NOT_LIVE' || error?.code === 'SESSION_NOT_FOUND'
    return writeJson(res, coldUnavailable ? 404 : 500,
      failure(coldUnavailable ? 'SESSION_NOT_LIVE' : (error?.code || 'SNAPSHOT_FAILED'), messageOf(error)))
  }

  let preview
  try {
    preview = previewContext(snapshot.messages, range, cfg)
  } catch (error) {
    return writeJson(res, 500, failure('SNAPSHOT_FAILED', messageOf(error)))
  }

  const headerConfig = headerConfigOf(snapshot)
  writeJson(res, 200, {
    ok: true,
    sessionId,
    cold: snapshot.cold === true,
    range: preview.range,
    stats: preview.stats,
    dropped: preview.dropped,
    provider: pickString(headerConfig.provider) ?? null,
    model: pickString(headerConfig.model) ?? null,
  })
}

async function handleAsk(ctx, cfg, req, res) {
  if (!fence(ctx, req, res)) return
  if (req.method !== 'POST') return writeJson(res, 405, failure('METHOD_NOT_ALLOWED', 'POST only'))

  let payload
  try {
    payload = await readJsonBody(req, cfg.maxBodyBytes)
  } catch (error) {
    return writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400,
      failure('BAD_REQUEST', messageOf(error)))
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return writeJson(res, 400, failure('BAD_REQUEST', 'JSON object body expected'))
  }

  const sessionId = pickString(payload.sessionId) ? payload.sessionId.trim() : ''
  const question = pickString(payload.question) ? payload.question.trim() : ''
  if (!sessionId) return writeJson(res, 400, failure('BAD_REQUEST', 'sessionId is required'))
  if (!question) return writeJson(res, 400, failure('BAD_REQUEST', 'question is required'))
  if (question.length > cfg.maxQuestionChars) {
    return writeJson(res, 400, failure('BAD_REQUEST', `question is longer than ${cfg.maxQuestionChars} characters`))
  }
  const range = normaliseRange(payload.range, cfg)

  let snapshot
  try {
    snapshot = await resolveSnapshot(ctx, sessionId, cfg)
  } catch (error) {
    const coldUnavailable = error?.code === 'SESSION_NOT_LIVE' || error?.code === 'SESSION_NOT_FOUND'
    return writeJson(res, coldUnavailable ? 404 : 500,
      failure(coldUnavailable ? 'SESSION_NOT_LIVE' : (error?.code || 'SNAPSHOT_FAILED'), messageOf(error)))
  }

  let preview
  try {
    preview = previewContext(snapshot.messages, range, cfg)
  } catch (error) {
    return writeJson(res, 500, failure('SNAPSHOT_FAILED', messageOf(error)))
  }

  const focus = normaliseFocus(payload.focus, snapshot.messages)

  const headerConfig = headerConfigOf(snapshot)
  const provider = pickString(payload.provider) ?? pickString(headerConfig.provider)
  const model = pickString(payload.model) ?? pickString(headerConfig.model)
  if (!provider || !model) {
    return writeJson(res, 500, failure('NO_ROUTE', 'the conversation has no resolved provider/model yet'))
  }
  // An explicit picker choice is validated before the stream so a typo fails
  // with a readable 400 instead of a terminal NO_ADAPTER finish frame.
  if (pickString(payload.provider) || pickString(payload.model)) {
    try {
      await ctx.llm.resolveModelInfo(provider, model)
    } catch (error) {
      return writeJson(res, 400, failure('BAD_MODEL', `无法使用 ${provider}/${model}：${messageOf(error)}`))
    }
  }

  const priorTurns = normalisePriorTurns(payload.priorTurns, cfg.maxPriorTurns)
  let messages
  try {
    messages = buildBtwMessages(preview.messages, question, priorTurns, {
      fallbackRoute: { provider, model },
      focus,
    })
  } catch (error) {
    return writeJson(res, 400, failure('BAD_REQUEST', messageOf(error)))
  }

  const options = { ...headerConfig, provider, model, messages, sessionId }
  if (pickString(payload.reasoningEffort)) options.reasoningEffort = payload.reasoningEffort
  if (typeof payload.temperature === 'number' && Number.isFinite(payload.temperature)
    && payload.temperature >= 0 && payload.temperature <= 2) {
    options.temperature = payload.temperature
  }
  if (Number.isInteger(payload.maxTokens) && payload.maxTokens > 0) {
    options.maxTokens = Math.min(payload.maxTokens, 32_768)
  }
  if (cfg.toolParity === true) {
    // Parity mode (ds-bot callAside): same request shape as the conversation.
    // The prompt forbids tools, and a tool-calls finish is reported as an error.
    if (Array.isArray(snapshot.header?.tools)) options.tools = [...snapshot.header.tools]
    if (snapshot.toolHistory !== undefined) options.toolHistory = snapshot.toolHistory
  }

  const abort = new AbortController()
  const onClose = () => abort.abort()
  res.once('close', onClose)

  // Safety net: a stalled provider stream must not keep the socket open forever.
  const timeoutMs = Number.isFinite(cfg.requestTimeoutMs) && cfg.requestTimeoutMs > 0
    ? cfg.requestTimeoutMs
    : 5 * 60 * 1000
  const watchdog = setTimeout(() => abort.abort(), timeoutMs)
  watchdog.unref?.()

  writeSseHead(res)
  // The first frame mirrors /btw/context so the badge stays truthful even if
  // the user changed the range right before pressing send.
  writeSse(res, 'meta', {
    range: preview.range,
    stats: preview.stats,
    dropped: preview.dropped,
    cold: snapshot.cold === true,
    provider,
    model,
  })

  let text = ''
  let usage
  let finish
  try {
    for await (const chunk of ctx.llm.stream({ ...options, signal: abort.signal })) {
      if (res.writableEnded) break
      switch (chunk?.type) {
        case 'text-delta':
          text += chunk.text
          writeSse(res, 'delta', { kind: 'text', text: chunk.text })
          break
        case 'reasoning-delta':
          writeSse(res, 'delta', { kind: 'reasoning', text: chunk.text })
          break
        case 'usage':
          usage = chunk.usage
          writeSse(res, 'usage', chunk.usage)
          break
        case 'finish':
          finish = chunk.reason
          break
        default:
          break
      }
      if (abort.signal.aborted) break
    }
  } catch (error) {
    clearTimeout(watchdog)
    res.off?.('close', onClose)
    if (!res.writableEnded) {
      endSse(res, 'error', abort.signal.aborted
        ? { code: 'ABORTED', message: '已中止' }
        : { code: 'STREAM_ERROR', message: messageOf(error) })
    }
    return
  }
  clearTimeout(watchdog)
  res.off?.('close', onClose)
  if (res.writableEnded) return
  if (abort.signal.aborted) return endSse(res, 'error', { code: 'ABORTED', message: '已中止' })

  const summary = {
    range: preview.range,
    stats: preview.stats,
    dropped: preview.dropped,
    cold: snapshot.cold === true,
  }
  const reason = finish && typeof finish === 'object' ? finish : { kind: 'stop' }
  switch (reason.kind) {
    case 'stop':
      return endSse(res, 'done', { text, usage, provider, model, truncated: false, ...summary })
    case 'max-tokens':
      return endSse(res, 'done', { text, usage, provider, model, truncated: true, ...summary })
    case 'tool-calls':
      return endSse(res, 'error', {
        code: 'TOOL_CALLS',
        message: '模型尝试调用工具，btw 只做纯问答；请重试或换个问法',
      })
    case 'aborted':
      return endSse(res, 'error', { code: 'ABORTED', message: '已中止' })
    case 'error':
      return endSse(res, 'error', mapFailure(reason.failure))
    default:
      return endSse(res, 'done', { text, usage, provider, model, truncated: false, ...summary })
  }
}

/* ------------------------------------------------------ transfer to parent */

/**
 * Compress the dialog transcript into a short record. The model call is a
 * normal, non-streaming llm.stream(); any failure (or an empty answer) falls
 * back to a deterministic digest so the user can still review and send it.
 */
async function handleSummarize(ctx, cfg, req, res) {
  if (!fence(ctx, req, res)) return
  if (req.method !== 'POST') return writeJson(res, 405, failure('METHOD_NOT_ALLOWED', 'POST only'))

  let payload
  try {
    payload = await readJsonBody(req, cfg.maxBodyBytes)
  } catch (error) {
    return writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400,
      failure('BAD_REQUEST', messageOf(error)))
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return writeJson(res, 400, failure('BAD_REQUEST', 'JSON object body expected'))
  }

  const sessionId = pickString(payload.sessionId) ? payload.sessionId.trim() : ''
  if (!sessionId) return writeJson(res, 400, failure('BAD_REQUEST', 'sessionId is required'))
  const messages = normaliseDialogMessages(payload.messages)
  if (messages.length === 0) {
    return writeJson(res, 400, failure('BAD_REQUEST', 'messages must contain at least one user or assistant turn'))
  }
  const focus = payload.focus && typeof payload.focus === 'object' && pickString(payload.focus.text)
    ? { text: payload.focus.text.trim().slice(0, FOCUS_MAX_CHARS) }
    : null

  let prompt
  try {
    prompt = buildSummaryPrompt(messages, { focus })
  } catch (error) {
    return writeJson(res, 400, failure('BAD_REQUEST', messageOf(error)))
  }

  let route
  try {
    route = await resolveSummaryRoute(ctx, payload)
  } catch (error) {
    const status = error?.code === 'BAD_MODEL' ? 400 : 500
    return writeJson(res, status, failure(error?.code || 'NO_ROUTE', messageOf(error)))
  }

  const abort = new AbortController()
  const timeoutMs = Number.isFinite(cfg.summaryTimeoutMs) && cfg.summaryTimeoutMs > 0
    ? cfg.summaryTimeoutMs
    : 60_000
  const watchdog = setTimeout(() => abort.abort(), timeoutMs)
  watchdog.unref?.()

  let text = ''
  let usage
  let warning = null
  try {
    for await (const chunk of ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      temperature: 0.2,
      maxTokens: 1200,
      signal: abort.signal,
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'usage') usage = chunk.usage
    }
  } catch (error) {
    warning = abort.signal.aborted ? '摘要生成超时，已改用本地摘要' : `摘要生成失败：${messageOf(error)}`
  } finally {
    clearTimeout(watchdog)
  }

  let summary = cleanSummary(text, 4000)
  let fallback = false
  if (summary === '') {
    summary = fallbackSummary(messages)
    fallback = true
    if (!warning) warning = '模型没有返回摘要，已改用本地摘要'
  }
  writeJson(res, 200, {
    ok: true,
    summary,
    fallback,
    warning: warning || undefined,
    provider: route.provider,
    model: route.model,
    usage,
  })
}

async function resolveSummaryRoute(ctx, payload) {
  const provider = pickString(payload.provider)
  const model = pickString(payload.model)
  if (provider || model) {
    if (!provider || !model) throw coded(new Error('provider 和 model 需要同时提供'), 'BAD_MODEL')
    try {
      await ctx.llm.resolveModelInfo(provider, model)
    } catch (error) {
      throw coded(new Error(`无法使用 ${provider}/${model}：${messageOf(error)}`), 'BAD_MODEL')
    }
    return { provider, model }
  }
  const fallback = defaultRoute(ctx)
  if (fallback) return fallback
  throw coded(new Error('没有可用的默认模型，请先在 btw 里选一个模型'), 'NO_ROUTE')
}

/**
 * Append the reviewed summary to the parent as a user/message with a custom
 * `source.kind = 'btw'`. DSH renders non-`user` sources as a context/notice
 * card and the next request's deriveMessages() picks the event up, so the
 * parent agent sees it without waking a turn now.
 */
async function handleCommit(ctx, cfg, req, res) {
  if (!fence(ctx, req, res)) return
  if (req.method !== 'POST') return writeJson(res, 405, failure('METHOD_NOT_ALLOWED', 'POST only'))

  let payload
  try {
    payload = await readJsonBody(req, cfg.maxBodyBytes)
  } catch (error) {
    return writeJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400,
      failure('BAD_REQUEST', messageOf(error)))
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return writeJson(res, 400, failure('BAD_REQUEST', 'JSON object body expected'))
  }

  const sessionId = pickString(payload.sessionId) ? payload.sessionId.trim() : ''
  if (!sessionId) return writeJson(res, 400, failure('BAD_REQUEST', 'sessionId is required'))
  const rawSummary = typeof payload.summary === 'string' ? payload.summary.trim() : ''
  if (!rawSummary) return writeJson(res, 400, failure('BAD_REQUEST', 'summary is required'))
  const limit = Number.isInteger(cfg.maxSummaryChars) && cfg.maxSummaryChars > 0 ? cfg.maxSummaryChars : 8000
  if (rawSummary.length > limit) {
    return writeJson(res, 400, failure('BAD_REQUEST', `summary is longer than ${limit} characters`))
  }

  const session = pickSession(ctx, sessionId)
  if (!session || typeof session.append !== 'function') {
    return writeJson(res, 409, failure('SESSION_NOT_LIVE', '主会话未打开，无法写入；请回到该会话后重试'))
  }
  let running = false
  try {
    running = serviceOf(ctx, 'agents')?.get?.(sessionId)?.status === 'running'
  } catch { /* the agent registry is optional for this check */ }
  if (running) {
    return writeJson(res, 409, failure('SESSION_BUSY', '主会话正在生成回答，请等它结束再送入'))
  }

  const meta = normaliseSummaryMeta({ turns: payload.turns, at: payload.at, focus: payload.focus === true })
  let body
  try {
    body = buildInjectionBody(rawSummary, meta)
  } catch (error) {
    return writeJson(res, 400, failure('BAD_REQUEST', messageOf(error)))
  }

  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: body }],
    source: { kind: 'btw', form: 'notice', at: meta.at, turns: meta.turns, focus: meta.focus },
  }
  let event
  try {
    event = session.append('user/message', message, { surfaceOp: 'append' })
  } catch (error) {
    return writeJson(res, 500, failure('APPEND_FAILED', `写入主会话失败：${messageOf(error)}`))
  }
  writeJson(res, 200, {
    ok: true,
    seq: Number.isFinite(event?.seq) ? event.seq : null,
    turns: meta.turns,
  })
}

/* --------------------------------------------------------------- snapshots */

/**
 * Resolve the model-visible history for `sessionId`: live sessions first, then
 * the cold path (persisted log folded into messages). Throws
 * `code: 'SESSION_NOT_FOUND'` when neither source knows the id.
 */
async function resolveSnapshot(ctx, sessionId, cfg) {
  const session = pickSession(ctx, sessionId)
  if (session) {
    try {
      return { ...snapshotOf(session), cold: false }
    } catch (error) {
      throw coded(error, 'SNAPSHOT_FAILED')
    }
  }
  return coldSnapshot(ctx, sessionId, cfg)
}

/** What cold-read capability this composition has (for /btw/health). */
function coldReadKind(ctx) {
  if (typeof serviceOf(ctx, 'sessionQuery')?.readSession === 'function') return 'sessionQuery'
  if (typeof serviceOf(ctx, 'sessionPersistence')?.open === 'function') return 'sessionPersistence'
  return 'none'
}

async function coldSnapshot(ctx, sessionId, cfg) {
  const query = serviceOf(ctx, 'sessionQuery')
  const persistence = serviceOf(ctx, 'sessionPersistence')
  let events
  try {
    if (query && typeof query.readSession === 'function') {
      const loaded = await query.readSession(sessionId)
      events = loaded && Array.isArray(loaded.events) ? loaded.events : undefined
    } else if (persistence && typeof persistence.open === 'function') {
      const handle = await persistence.open(sessionId, 'read')
      try {
        const read = await handle.read()
        events = read && Array.isArray(read.events) ? read.events : undefined
      } finally {
        try { await handle.close?.() } catch { /* closing is best effort */ }
      }
    } else {
      throw coded(new Error('this build exposes neither ctx.sessionQuery nor ctx.sessionPersistence'), 'SESSION_NOT_LIVE')
    }
  } catch (error) {
    if (isNotFound(error)) throw coded(new Error('session not found'), 'SESSION_NOT_FOUND')
    throw coded(error, error?.code && String(error.code).startsWith('SESSION_QUERY_') ? 'SESSION_NOT_LIVE' : 'COLD_READ_FAILED')
  }
  if (!Array.isArray(events) || events.length === 0) throw coded(new Error('the persisted session has no events'), 'SESSION_NOT_FOUND')

  try {
    return foldEventsToSnapshot(events, sessionId)
  } catch (error) {
    throw coded(error, 'COLD_READ_FAILED')
  }
}

function headerConfigOf(snapshot) {
  return snapshot?.header?.config && typeof snapshot.header.config === 'object'
    ? snapshot.header.config
    : {}
}

function coded(error, code) {
  const wrapped = error instanceof Error ? error : new Error(String(error))
  if (!wrapped.code) wrapped.code = code
  return wrapped
}

function isNotFound(error) {
  if (!error) return false
  const code = typeof error.code === 'string' ? error.code : ''
  if (code.includes('NOT_FOUND')) return true
  if (error.name === 'SessionPersistenceNotFoundError') return true
  return /not found|no such session|absent/i.test(String(error.message || ''))
}

/* ------------------------------------------------------------------ helpers */

function pickString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/** Cordis service lookup that also works for optional (non-injected) services. */
function serviceOf(ctx, name) {
  if (!ctx) return null
  if (typeof ctx.get === 'function') {
    try {
      const service = ctx.get(name)
      if (service) return service
    } catch { /* not mounted in this composition */ }
  }
  try {
    return ctx[name] || null
  } catch {
    return null
  }
}

/** Consult the host admission policy (DSH 0.2.0-rc.2+); 401/403 when rejected. */
function fence(ctx, req, res) {
  let rejection
  try {
    rejection = typeof ctx.connection?.requestRejection === 'function'
      ? ctx.connection.requestRejection(req)
      : undefined
  } catch {
    rejection = 403
  }
  if (rejection === undefined || rejection === null || rejection === false) return true
  writeJson(res, rejection === 401 ? 401 : 403, failure('FORBIDDEN', 'rejected by the host admission policy'))
  return false
}

function writeJson(res, status, body) {
  if (res.writableEnded) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function writeSseHead(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  if (typeof res.flushHeaders === 'function') res.flushHeaders()
}

function writeSse(res, event, data) {
  if (res.writableEnded) return
  try {
    res.write(sseFrame(event, data))
  } catch {
    /* the peer went away; the close listener aborts the upstream request */
  }
}

function endSse(res, event, data) {
  writeSse(res, event, data)
  try { res.end() } catch { /* already closed */ }
}

/** Read a JSON request body with a hard byte cap (413 on overflow). */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let failed = false
    req.on('data', (chunk) => {
      if (failed) return
      size += chunk.length
      if (size > limit) {
        failed = true
        const error = new Error(`request body exceeds ${limit} bytes`)
        error.statusCode = 413
        reject(error)
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (failed) return
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw.trim() === '' ? {} : JSON.parse(raw))
      } catch {
        const error = new Error('invalid JSON body')
        error.statusCode = 400
        reject(error)
      }
    })
    req.on('error', (error) => {
      if (!failed) {
        failed = true
        reject(error)
      }
    })
  })
}
