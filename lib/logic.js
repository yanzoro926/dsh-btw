/**
 * dsh-btw — pure host-side helpers.
 *
 * Everything here is deliberately free of DSH imports so it can be unit-tested
 * with plain `node --test`. The plugin's host half (lib/index.js) only wires
 * these helpers to Cordis services.
 *
 * The snapshot/model-call shape follows ds-bot 0.2.4 (`src/host/btw.js`):
 * requestHeader() + trimToolBoundary(deriveMessages()) + toolHistory(), then a
 * single ctx.llm.stream() call. Nothing is appended to the parent session.
 */

export const DEFAULT_CONFIG = {
  enabled: true,
  /** Hard cap on the parent-snapshot messages sent to the model (oldest first are dropped). */
  maxParentMessages: 200,
  /** Ceiling for the explicit "all" / "no tool output" ranges (a model window is still model-specific). */
  maxRangeMessages: 1000,
  /** Default for the "最近 N 条" range. */
  defaultRecentMessages: 40,
  /** How many earlier dialog turns the client may send back with a follow-up question. */
  maxPriorTurns: 20,
  maxQuestionChars: 8000,
  maxBodyBytes: 1024 * 1024,
  /** Abort an ask that runs longer than this (ms); guards against a hung provider. */
  requestTimeoutMs: 5 * 60 * 1000,
  /** Abort a summary call that runs longer than this (ms). */
  summaryTimeoutMs: 60 * 1000,
  /** Hard cap for the (possibly user-edited) summary written into the parent. */
  maxSummaryChars: 8000,
  /** true → mirror ds-bot's parity mode: pass header.tools + toolHistory. */
  toolParity: false,
}

/**
 * Drop a trailing assistant tool-call whose tool/result has not been logged yet.
 * Copied from ds-bot/src/host/btw.js:92-104; a frozen DSH history must never be
 * mutated, so a shortened array is returned when trimming happens.
 *
 * @param {ReadonlyArray<any>} messages
 * @returns {ReadonlyArray<any>}
 */
export function trimToolBoundary(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  let index = messages.length
  while (index > 0 && messages[index - 1]?.role === 'tool') index -= 1
  if (index === 0 || index === messages.length) return messages
  const previous = messages[index - 1]
  const calls = (Array.isArray(previous?.content) ? previous.content : [])
    .filter(block => block && block.type === 'tool-call')
    .map(block => block.id)
  if (calls.length === 0) return messages
  const results = new Set(messages.slice(index).map(message => message?.toolCallId))
  return calls.every(id => results.has(id)) ? messages : messages.slice(0, index - 1)
}

/**
 * Snapshot the model-visible context of a live session.
 * requestHeader()/toolHistory() are Session methods found in DSH 0.2.1-rc.5
 * (dsh-session/lib/index.js:1612 and :1643) but not documented in its README,
 * hence the feature detection. When they are missing the caller still gets the
 * derived messages, so a plain (route-less) request is possible.
 *
 * @param {{ id?: string, requestHeader?: () => any, deriveMessages: () => any[], toolHistory?: () => any }} session
 */
export function snapshotOf(session) {
  if (!session || typeof session.deriveMessages !== 'function') {
    throw new Error('session does not expose deriveMessages()')
  }
  const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
  const messages = trimToolBoundary(session.deriveMessages())
  const toolHistory = typeof session.toolHistory === 'function' ? session.toolHistory() : undefined
  return { header, messages, toolHistory, sessionId: session.id }
}

export const BTW_PROMPT = [
  'ds-btw/aside',
  "Below is a read-only snapshot of the user's current conversation. It is reference background, not your current task.",
  'Answer the question from that snapshot when it suffices; otherwise say exactly what is missing.',
  'Do not call any tool.',
  'Nothing you say here is written back into that conversation.',
  'Never claim to have done anything.',
].join('\n')

export const BTW_RETRY = 'Do not call any tool. Answer in plain text only.'

/** Build the trailing user prompt (boundary text + optional retry reminder + question). */
export function buildBtwPrompt(question, retry = false) {
  return [BTW_PROMPT, ...(retry ? [BTW_RETRY] : []), String(question)].join('\n\n')
}

function textContent(text) {
  return [{ type: 'text', text: String(text) }]
}

/**
 * One earlier dialog turn → one request message. Assistant messages carry a
 * `source` tag because provider adapters read it (ds-bot/src/host/side.js:35-40).
 *
 * @param {{ role: string, text: string, provider?: string, model?: string }} turn
 * @param {{ provider?: string, model?: string }} [fallbackRoute]
 */
export function turnToMessage(turn, fallbackRoute = {}) {
  if (!turn || typeof turn.text !== 'string' || turn.text.length === 0) {
    throw new Error('prior turn needs a non-empty text')
  }
  if (turn.role === 'user') return { role: 'user', content: textContent(turn.text) }
  if (turn.role !== 'assistant') throw new Error(`unsupported prior-turn role: ${String(turn.role)}`)
  const provider = typeof turn.provider === 'string' && turn.provider ? turn.provider : fallbackRoute.provider
  const model = typeof turn.model === 'string' && turn.model ? turn.model : fallbackRoute.model
  const message = { role: 'assistant', content: textContent(turn.text) }
  if (provider && model) message.source = { kind: 'model', provider, model }
  return message
}

/**
 * Validate and cap the dialog history sent by the browser. The host never
 * trusts it beyond this shape: only user/assistant text turns are accepted.
 *
 * @param {unknown} raw
 * @param {number} [max]
 */
export function normalisePriorTurns(raw, max = DEFAULT_CONFIG.maxPriorTurns) {
  if (!Array.isArray(raw)) return []
  const turns = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    if (value.role !== 'user' && value.role !== 'assistant') continue
    if (typeof value.text !== 'string' || value.text.trim() === '') continue
    turns.push({
      role: value.role,
      text: String(value.text).slice(0, 32_000),
      ...(typeof value.provider === 'string' && value.provider ? { provider: value.provider } : {}),
      ...(typeof value.model === 'string' && value.model ? { model: value.model } : {}),
    })
  }
  // Keep the most recent turns: older dialog history is the least relevant.
  return max > 0 && turns.length > max ? turns.slice(-max) : turns
}

/**
 * Assemble the exact request: parent snapshot, earlier dialog pairs, then the
 * new question. `snapshotMessages` is expected to have been through
 * trimToolBoundary already (snapshotOf does that). `options.focus` (from a
 * per-message action or a text selection) is quoted ahead of the question.
 */
export function buildBtwMessages(snapshotMessages, question, priorTurns = [], options = {}) {
  const { retry = false, fallbackRoute = {}, focus = null } = options
  if (typeof question !== 'string' || question.trim() === '') {
    throw new Error('question must be a non-empty string')
  }
  const extra = priorTurns.map(turn => turnToMessage(turn, fallbackRoute))
  const preamble = buildFocusPreamble(focus)
  const prompt = buildBtwPrompt(question.trim(), retry)
  return [
    ...snapshotMessages,
    ...extra,
    { role: 'user', content: textContent(preamble ? `${preamble}\n\n${prompt}` : prompt) },
  ]
}

/** Longest quote accepted from a selection or a focused message. */
export const FOCUS_MAX_CHARS = 2000

/** Pull plain text out of a message for use as a quoted excerpt. */
export function messageQuote(message, max = FOCUS_MAX_CHARS) {
  if (!message || !Array.isArray(message.content)) return ''
  const parts = []
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim().slice(0, max)
}

/**
 * Turn a `{ kind, text, role }` focus into a prompt preamble. `kind` is either
 * `message` (a specific finalized message) or `selection` (text the user picked).
 */
export function buildFocusPreamble(focus) {
  if (!focus || typeof focus !== 'object') return ''
  const text = typeof focus.text === 'string' ? focus.text.trim() : ''
  if (text === '') return ''
  const label = focus.kind === 'message'
    ? `会话中的一条 ${focus.role || 'assistant'} 消息`
    : '用户选中的文本'
  return [
    `[btw] 用户正在针对${label}提问，引用如下：`,
    '"""',
    text.slice(0, FOCUS_MAX_CHARS),
    '"""',
    '请优先解释或回答与此段内容相关的问题；如果会话快照不足以回答，请明确说明。',
  ].join('\n')
}

/**
 * Keep the newest `max` parent messages, never starting on an orphan `tool`
 * result. The parent snapshot prefix stays byte-identical to the main request
 * until the cut point, which keeps provider KV-cache reuse plausible.
 */
export function pruneMessages(messages, max = DEFAULT_CONFIG.maxParentMessages) {
  if (!Array.isArray(messages)) return []
  if (messages.length <= max) return messages
  let start = messages.length - max
  while (start < messages.length && messages[start]?.role === 'tool') start += 1
  return messages.slice(start)
}

/* ------------------------------------------------------- context ranges (B) */

/** Range modes accepted from the browser; `auto` = the host's own default cap. */
export const RANGE_MODES = ['auto', 'all', 'recent', 'no-tools']

export const RANGE_LABELS = {
  auto: '自动',
  all: '全部',
  recent: '最近 N 条',
  'no-tools': '不含工具输出',
}

/** Validate the browser's range request and fill defaults. */
export function normaliseRange(raw, defaults = DEFAULT_CONFIG) {
  const fallbackRecent = defaults.defaultRecentMessages > 0 ? defaults.defaultRecentMessages : 40
  if (!raw || typeof raw !== 'object') return { mode: 'auto', recentMessages: fallbackRecent }
  const mode = RANGE_MODES.includes(raw.mode) ? raw.mode : 'auto'
  let recentMessages = Number.isFinite(raw.recentMessages) ? Math.round(raw.recentMessages) : fallbackRecent
  recentMessages = Math.min(Math.max(recentMessages, 2), 500)
  return { mode, recentMessages }
}

/**
 * Drop tool traffic from a model-visible history: tool/result messages and the
 * assistant `tool-call` blocks are removed together, so the remaining request
 * never contains a call without its result (or the reverse). Assistant messages
 * that carried only tool calls disappear.
 */
export function stripToolMessages(messages) {
  if (!Array.isArray(messages)) return []
  const out = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    if (message.role === 'tool') continue
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const content = message.content.filter(block => !(block && block.type === 'tool-call'))
      if (content.length === 0) continue
      out.push(content.length === message.content.length ? message : { ...message, content })
      continue
    }
    out.push(message)
  }
  return out
}

/**
 * Apply the requested range to a snapshot. Returns the messages to send plus
 * how many were cut, so the UI can show "已裁剪 N 条" instead of silently
 * shortening the context.
 */
export function applyRange(messages, range, config = DEFAULT_CONFIG) {
  const source = Array.isArray(messages) ? messages : []
  const normalised = normaliseRange(range, config)
  let ranged
  switch (normalised.mode) {
    case 'recent':
      ranged = pruneMessages(source, normalised.recentMessages)
      break
    case 'no-tools':
      ranged = pruneMessages(stripToolMessages(source), capOf(config, 'maxRangeMessages', 1000))
      break
    case 'all':
      ranged = pruneMessages(source, capOf(config, 'maxRangeMessages', 1000))
      break
    case 'auto':
    default:
      ranged = pruneMessages(source, capOf(config, 'maxParentMessages', 200))
      break
  }
  return { messages: ranged, dropped: Math.max(0, source.length - ranged.length), range: normalised }
}

function capOf(config, key, fallback) {
  const value = config && Number.isFinite(config[key]) ? config[key] : fallback
  return value > 0 ? Math.round(value) : fallback
}

/* ------------------------------------------------ snapshot statistics (B) */

const CJK_PATTERN = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g

/**
 * Rough token estimate (the host does not expose a tokenizer to plugins).
 * CJK characters count ~1 token each, other words ~1.3, plus a tiny per-message
 * overhead in {@link messagesStats}. Only used for the UI's context badge.
 */
export function estimateTokens(text) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  if (value === '') return 0
  const cjk = (value.match(CJK_PATTERN) || []).length
  const rest = value.replace(CJK_PATTERN, ' ').trim()
  const words = rest === '' ? 0 : rest.split(/\s+/).length
  return Math.ceil(cjk + words * 1.3)
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  let text = ''
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += (text ? '\n' : '') + block.text
    else if (block && block.type === 'tool-call' && typeof block.arguments === 'string') text += block.arguments
  }
  return text
}

/** `{ messages, chars, tokens }` for one model-visible history. */
export function messagesStats(messages) {
  const list = Array.isArray(messages) ? messages : []
  let chars = 0
  let tokens = 0
  for (const message of list) {
    const text = messageText(message)
    chars += text.length
    tokens += 4 + estimateTokens(text)
  }
  return { messages: list.length, chars, tokens }
}

/**
 * Snapshot → range → stats, in the exact order the ask route uses. The context
 * preview endpoint and `/btw/ask` share this so the badge and the real request
 * can never disagree.
 */
export function previewContext(snapshotMessages, range, config = DEFAULT_CONFIG) {
  const applied = applyRange(snapshotMessages, range, config)
  return {
    messages: applied.messages,
    dropped: applied.dropped,
    range: applied.range,
    stats: messagesStats(applied.messages),
  }
}

/**
 * Surface-eligible event types (dsh-session/lib/index.js:SURFACE_EVENT_TYPES).
 * Only these derive an LLM message; everything else is log-only.
 */
const SURFACE_EVENT_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/** Fold `request/header` events the way dsh-session's foldRequestHeader does. */
function foldRequestHeaderOf(events) {
  let header
  for (const event of events) {
    if (event && event.type === 'request/header' && event.data && typeof event.data.header === 'object') {
      header = canonicalHeaderOf(event.data.header)
    }
  }
  return header
}

function canonicalHeaderOf(header) {
  const adapterDefaults = header.adapterDefaults
  return {
    config: header.config,
    ...(adapterDefaults && (adapterDefaults.reasoningEffort === true || adapterDefaults.maxTokens === true)
      ? { adapterDefaults }
      : {}),
    ...(Array.isArray(header.tools) && header.tools.length > 0 ? { tools: header.tools } : {}),
  }
}

/** dsh-session's deriveEventMessage, without the projection map (see below). */
function deriveEventMessageOf(event) {
  if (!event || typeof event !== 'object') return null
  switch (event.type) {
    case 'user/message':
      return event.data || null
    case 'system/message':
    case 'developer/message':
    case 'assistant/message': {
      const message = event.data && event.data.message
      if (!message || !Array.isArray(message.content) || message.content.length === 0) return null
      return message
    }
    case 'tool/result':
      return (event.data && event.data.message) || null
    default:
      return null
  }
}

/**
 * Fold a persisted raw event log into a btw snapshot (cold sessions).
 *
 * Mirrors `foldSurface`/`deriveEventMessage` from `@deepseek-ai/dsh-session`
 * without importing it (a plugin's dynamic import resolves against its own
 * filesystem position, not the host's package table). Message *projections*
 * are intentionally not applied: they are display-level transforms registered
 * by other plugins; the request keeps the session's own committed content.
 *
 * @param {ReadonlyArray<any>} events contiguous log records (with `seq`)
 * @param {string} sessionId
 */
export function foldEventsToSnapshot(events, sessionId) {
  if (!Array.isArray(events) || events.length === 0) throw new Error('the persisted session has no events')

  const nodes = []
  for (const event of events) {
    if (!event || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq)) continue
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue
    const op = event.surfaceOp
    if (op && typeof op === 'object' && op.op === 'replace') {
      // Replacement ranges always point at events already on the surface.
      const startIndex = nodes.indexOf(op.startSeq)
      const endIndex = nodes.indexOf(op.endSeq)
      if (startIndex >= 0 && endIndex >= startIndex) nodes.splice(startIndex, endIndex - startIndex + 1)
    }
    nodes.push(event.seq)
  }

  const bySeq = new Map()
  for (const event of events) {
    if (event && Number.isSafeInteger(event.seq)) bySeq.set(event.seq, event)
  }
  const messages = []
  for (const seq of nodes) {
    const message = deriveEventMessageOf(bySeq.get(seq))
    if (message) messages.push(message)
  }

  return {
    header: foldRequestHeaderOf(events),
    messages: trimToolBoundary(messages),
    toolHistory: undefined,
    sessionId,
    cold: true,
  }
}

/** One SSE frame. `data` is JSON-encoded; the client parser splits on a blank line. */
export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`
}

const FAILURE_MESSAGES = {
  NO_ADAPTER: '没有可用的模型适配器（provider/model 未注册）',
  MISSING_CREDENTIAL: '模型凭据缺失',
  INVALID_CREDENTIAL: '模型凭据无效',
  AUTH: '模型鉴权失败',
  RATE_LIMIT: '触发限流，请稍后再试',
  CONTEXT_WINDOW_EXCEEDED: '上下文超出该模型窗口上限',
  QUOTA: '模型额度不足',
  ACCOUNT_QUOTA: '账户额度不足',
  ABORTED: '已中止',
}

/** Normalise an LlmFailure (finish.reason.failure) into an SSE error payload. */
export function mapFailure(failure) {
  const code = typeof failure?.code === 'string' && failure.code ? failure.code : 'LLM_ERROR'
  const message = FAILURE_MESSAGES[code]
    ?? (typeof failure?.message === 'string' && failure.message ? failure.message : '模型请求失败')
  return { code, message }
}

/** Best-effort human text for arbitrary thrown values (used by host handlers). */
export function messageOf(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) return error.message
  return String(error)
}

/**
 * Resolve the live session for a browser-requested id. Sessions owned by the
 * AgentRegistry are exposed through ctx.sessions; the agents fallback covers
 * builds where the session store and the registry are not the same face.
 */
export function pickSession(ctx, sessionId) {
  const direct = ctx.sessions?.get?.(sessionId)
  if (direct) return direct
  return ctx.agents?.get?.(sessionId)?.session
}

/* ------------------------------------------------------------ "送入主会话" */

/** Target length of the compressed record; the model is told to stay under it. */
export const SUMMARY_MAX_CHARS = 900
/** Transcript budget for the summarizer prompt (older turns are dropped first). */
export const SUMMARY_INPUT_CHARS = 12_000

export const SUMMARY_PROMPT = [
  '你是一个「旁问记录压缩器」。用户在主对话之外，针对主对话里不清楚的地方向另一个模型问了几个问题；下面是这段旁问的问答记录。',
  '请把它压缩成一条给主对话 agent 看的记录，帮助它理解用户关心什么、得到了什么结论。',
  '',
  '要求：',
  '1. 只保留能帮助理解主对话的信息：用户问了什么、结论、关键事实与数字、涉及的文件/路径/命令/API、仍未解决的点。',
  '2. 不编造；记录里没有的写「未提及」，不确定的写「不确定」。',
  '3. 不写寒暄、不重复完整推导；不要新增建议或行动。',
  '4. 用中文 Markdown，最多 900 字，按以下结构输出（没有内容的小节省略）：',
  '## 我问了什么',
  '## 结论',
  '## 关键细节',
  '## 仍未解决',
].join('\n')

/** Keep only renderable user/assistant turns from a client-supplied transcript. */
export function normaliseDialogMessages(raw) {
  if (!Array.isArray(raw)) return []
  const cleaned = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const role = entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : null
    if (!role) continue
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (text === '') continue
    cleaned.push({ role, text })
  }
  return cleaned
}

function summaryChunks(messages) {
  const chunks = []
  let turn = 0
  for (const entry of messages) {
    if (entry.role === 'user') {
      turn += 1
      chunks.push(`### 第 ${turn} 轮\n用户问：${entry.text}`)
    } else {
      chunks.push(`旁问回答：${entry.text}`)
    }
  }
  return chunks
}

/**
 * Build the summarizer input. The newest turns survive a transcript that is
 * over budget; the prompt says how many messages were dropped.
 */
export function buildSummaryPrompt(messages, options = {}) {
  const list = normaliseDialogMessages(messages)
  if (list.length === 0) throw new Error('没有可压缩的旁问对话')
  const focusText = options.focus && typeof options.focus.text === 'string'
    ? options.focus.text.trim().slice(0, 1000)
    : ''
  const chunks = summaryChunks(list)

  let omitted = 0
  let body = chunks.join('\n\n')
  while (body.length > SUMMARY_INPUT_CHARS && chunks.length > 1) {
    chunks.shift()
    omitted += 1
    body = chunks.join('\n\n')
  }
  if (body.length > SUMMARY_INPUT_CHARS) body = body.slice(0, SUMMARY_INPUT_CHARS)

  const parts = []
  if (focusText) parts.push(`[背景引用] 用户在主会话中选中了这段文字：「${focusText}」`)
  if (omitted > 0) parts.push(`（较早的 ${omitted} 条旁问消息因过长已省略）`)
  parts.push(body)
  return `${SUMMARY_PROMPT}\n\n---\n\n${parts.join('\n\n')}`
}

/** Normalise a model-produced (or user-edited) summary: no fences, no runs of blank lines. */
export function cleanSummary(raw, max = 4000) {
  let text = typeof raw === 'string' ? raw.trim() : ''
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
  }
  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`
  return text
}

/**
 * Deterministic fallback when the summarizer model fails: keep every question
 * and the opening of each answer, so the parent still gets the gist.
 */
export function fallbackSummary(messages, max = 700) {
  const list = normaliseDialogMessages(messages)
  const lines = []
  for (const entry of list) {
    if (entry.role === 'user') {
      lines.push(`- 问：${entry.text.length > 160 ? `${entry.text.slice(0, 160)}…` : entry.text}`)
    } else {
      const first = entry.text.split(/\n{2,}/)[0]
      lines.push(`  答：${first.length > 180 ? `${first.slice(0, 180)}…` : first}`)
    }
  }
  return cleanSummary(lines.join('\n'), max)
}

function stampOf(value) {
  const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value : Date.now())
  const safe = Number.isNaN(date.getTime()) ? new Date() : date
  const pad = (n) => String(n).padStart(2, '0')
  return `${safe.getFullYear()}-${pad(safe.getMonth() + 1)}-${pad(safe.getDate())} ${pad(safe.getHours())}:${pad(safe.getMinutes())}`
}

/** Validate the client-supplied commit metadata; bad fields fall back to neutral values. */
export function normaliseSummaryMeta(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const turns = Number.isInteger(source.turns) && source.turns > 0 ? Math.min(source.turns, 999) : 0
  const at = typeof source.at === 'string' && !Number.isNaN(Date.parse(source.at)) ? source.at : new Date().toISOString()
  return { turns, at, focus: source.focus === true }
}

/**
 * The text written into the parent. It is wrapped so the parent agent reads it
 * as background, not as a fresh instruction from the user.
 */
export function buildInjectionBody(summary, meta = {}) {
  const text = cleanSummary(summary, 8000)
  if (text === '') throw new Error('摘要为空')
  const info = normaliseSummaryMeta(meta)
  return [
    `【btw 旁问记录 · ${stampOf(info.at)}】`,
    '以下是我在主会话之外就一些不清楚的地方做的旁问，压缩记录如下，供你理解上下文；',
    '这不是新的用户指令，无需逐条回复。',
    '',
    text,
    '',
    `—— btw 插件写入${info.turns > 0 ? ` · 共 ${info.turns} 轮旁问` : ''}`,
  ].join('\n')
}

