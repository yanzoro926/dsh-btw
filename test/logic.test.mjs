import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyRange,
  buildBtwMessages,
  buildBtwPrompt,
  buildFocusPreamble,
  buildInjectionBody,
  buildSummaryPrompt,
  cleanSummary,
  estimateTokens,
  fallbackSummary,
  foldEventsToSnapshot,
  mapFailure,
  messageQuote,
  messagesStats,
  normaliseDialogMessages,
  normalisePriorTurns,
  normaliseRange,
  normaliseSummaryMeta,
  pickSession,
  previewContext,
  pruneMessages,
  snapshotOf,
  sseFrame,
  stripToolMessages,
  trimToolBoundary,
} from '../lib/logic.js'

const text = (value) => [{ type: 'text', text: value }]
const message = (role, value, extra = {}) => ({ role, content: text(value), ...extra })

test('trimToolBoundary keeps a balanced trailing tool exchange', () => {
  const messages = [
    message('user', 'hi'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] },
    { role: 'tool', content: text('result'), toolCallId: 'c1' },
  ]
  assert.equal(trimToolBoundary(messages), messages)
})

test('trimToolBoundary drops a partially answered multi-call turn', () => {
  const messages = [
    message('user', 'hi'),
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' },
        { type: 'tool-call', id: 'c2', name: 'y', arguments: '{}' },
      ],
    },
    { role: 'tool', content: text('only c1'), toolCallId: 'c1' },
  ]
  const trimmed = trimToolBoundary(messages)
  assert.deepEqual(trimmed, [messages[0]])
})

test('snapshotOf prefers requestHeader/toolHistory and trims messages', () => {
  const session = {
    id: 'session-1',
    requestHeader: () => ({ config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }, tools: [] }),
    deriveMessages: () => [message('user', 'hello')],
    toolHistory: () => ({ tools: [] }),
  }
  const snapshot = snapshotOf(session)
  assert.equal(snapshot.sessionId, 'session-1')
  assert.deepEqual(snapshot.header.config, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(snapshot.toolHistory, { tools: [] })
  assert.equal(snapshot.messages.length, 1)
})

test('snapshotOf tolerates older session shapes without requestHeader/toolHistory', () => {
  const session = { id: 'session-2', deriveMessages: () => [message('user', 'hello')] }
  const snapshot = snapshotOf(session)
  assert.equal(snapshot.header, undefined)
  assert.equal(snapshot.toolHistory, undefined)
  assert.equal(snapshot.messages.length, 1)
})

test('snapshotOf rejects a non-session', () => {
  assert.throws(() => snapshotOf(null), /deriveMessages/)
  assert.throws(() => snapshotOf({ id: 'x' }), /deriveMessages/)
})

test('buildBtwMessages orders snapshot → prior pairs → question', () => {
  const snapshotMessages = [message('user', 'parent context')]
  const priorTurns = [
    { role: 'user', text: 'first question' },
    { role: 'assistant', text: 'first answer' },
  ]
  const messages = buildBtwMessages(snapshotMessages, 'second question', priorTurns, {
    fallbackRoute: { provider: 'p', model: 'm' },
  })
  assert.equal(messages.length, 4)
  assert.equal(messages[0].content[0].text, 'parent context')
  assert.equal(messages[1].role, 'user')
  assert.equal(messages[2].role, 'assistant')
  assert.deepEqual(messages[2].source, { kind: 'model', provider: 'p', model: 'm' })
  assert.equal(messages[3].role, 'user')
  assert.match(messages[3].content[0].text, /second question$/)
  assert.match(messages[3].content[0].text, /Do not call any tool/)
})

test('buildBtwPrompt appends the retry reminder before the question', () => {
  const prompt = buildBtwPrompt('why?', true)
  assert.match(prompt, /ds-btw\/aside/)
  assert.match(prompt, /Do not call any tool\. Answer in plain text only\./)
  assert.match(prompt, /why\?$/)
})

test('buildBtwMessages refuses an empty question', () => {
  assert.throws(() => buildBtwMessages([], '   '), /question/)
})

test('messageQuote keeps only text blocks and caps the quote', () => {
  const quoted = messageQuote({
    role: 'assistant',
    content: [
      { type: 'text', text: 'first' },
      { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' },
      { type: 'text', text: 'second' },
    ],
  })
  assert.equal(quoted, 'first\nsecond')
  assert.equal(messageQuote({ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(50) }] }, 10).length, 10)
  assert.equal(messageQuote({ role: 'tool', content: [] }), '')
  assert.equal(messageQuote(null), '')
})

test('buildFocusPreamble quotes the selection and labels a message kind', () => {
  const selection = buildFocusPreamble({ kind: 'selection', text: 'selected words' })
  assert.match(selection, /用户选中的文本/)
  assert.match(selection, /selected words/)
  assert.match(selection, /请优先解释或回答与此段内容相关的问题/)

  const messageFocus = buildFocusPreamble({ kind: 'message', role: 'assistant', text: 'the answer' })
  assert.match(messageFocus, /会话中的一条 assistant 消息/)
  assert.match(messageFocus, /the answer/)

  assert.equal(buildFocusPreamble(null), '')
  assert.equal(buildFocusPreamble({ kind: 'selection', text: '  ' }), '')
})

test('buildBtwMessages prefixes the question with the focus preamble', () => {
  const messages = buildBtwMessages([], 'why this?', [], {
    fallbackRoute: { provider: 'p', model: 'm' },
    focus: { kind: 'selection', text: 'quoted line' },
  })
  assert.equal(messages.length, 1)
  assert.match(messages[0].content[0].text, /quoted line/)
  assert.match(messages[0].content[0].text, /why this\?$/)
})

test('normalisePriorTurns rejects malformed entries and caps the list', () => {
  const turns = normalisePriorTurns([
    null,
    { role: 'system', text: 'nope' },
    { role: 'user', text: '   ' },
    { role: 'user', text: 'ok' },
    { role: 'assistant', text: 'answer', provider: 'p', model: 'm' },
    'nope',
  ])
  assert.deepEqual(turns, [
    { role: 'user', text: 'ok' },
    { role: 'assistant', text: 'answer', provider: 'p', model: 'm' },
  ])
  const capped = normalisePriorTurns(
    Array.from({ length: 25 }, (_, index) => ({ role: 'user', text: `q${index}` })),
    20,
  )
  assert.equal(capped.length, 20)
  assert.equal(capped[19].text, 'q24')
})

test('pruneMessages keeps the newest messages and skips orphan tool results', () => {
  const roles = ['user', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool']
  const messages = roles.map((role, index) => message(role, `m${index}`, role === 'tool' ? { toolCallId: `c${index}` } : {}))
  const pruned = pruneMessages(messages, 4)
  assert.ok(pruned.length > 0)
  assert.notEqual(pruned[0].role, 'tool')
  assert.equal(pruned[pruned.length - 1], messages[messages.length - 1])
})

test('pruneMessages returns the input when it already fits', () => {
  const messages = [message('user', 'a'), message('assistant', 'b')]
  assert.equal(pruneMessages(messages, 10), messages)
})

test('sseFrame emits one blank-line-terminated frame', () => {
  assert.equal(sseFrame('delta', { kind: 'text', text: 'hi' }), 'event: delta\ndata: {"kind":"text","text":"hi"}\n\n')
})

test('mapFailure maps known codes and falls back to the raw message', () => {
  assert.equal(mapFailure({ code: 'NO_ADAPTER' }).code, 'NO_ADAPTER')
  assert.match(mapFailure({ code: 'NO_ADAPTER' }).message, /适配器/)
  assert.deepEqual(mapFailure({ code: 'SOMETHING', message: 'boom' }), { code: 'SOMETHING', message: 'boom' })
  assert.equal(mapFailure(undefined).code, 'LLM_ERROR')
})

test('pickSession prefers the session store and falls back to the agent registry', () => {
  const direct = { id: 'direct' }
  const viaAgent = { session: { id: 'agent' } }
  assert.equal(pickSession({ sessions: { get: () => direct } }, 's'), direct)
  assert.deepEqual(pickSession({ sessions: { get: () => undefined }, agents: { get: () => viaAgent } }, 's'), viaAgent.session)
  assert.equal(pickSession({}, 's'), undefined)
})

/* ------------------------------------------------------------ context ranges */

test('normaliseRange defaults to auto and clamps the recent window', () => {
  assert.deepEqual(normaliseRange(undefined), { mode: 'auto', recentMessages: 40 })
  assert.deepEqual(normaliseRange({ mode: 'recent', recentMessages: 1 }), { mode: 'recent', recentMessages: 2 })
  assert.deepEqual(normaliseRange({ mode: 'recent', recentMessages: 9999 }), { mode: 'recent', recentMessages: 500 })
  assert.deepEqual(normaliseRange({ mode: 'wat' }), { mode: 'auto', recentMessages: 40 })
  assert.deepEqual(normaliseRange({ mode: 'recent' }, { defaultRecentMessages: 80 }), { mode: 'recent', recentMessages: 80 })
})

test('stripToolMessages removes tool results and tool-call blocks together', () => {
  const messages = [
    message('user', 'hi'),
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] },
    { role: 'tool', content: text('result'), toolCallId: 'c1' },
    { role: 'assistant', content: [...text('answer'), { type: 'tool-call', id: 'c2', name: 'y', arguments: '{}' }] },
  ]
  const stripped = stripToolMessages(messages)
  assert.equal(stripped.length, 2)
  assert.equal(stripped[0], messages[0])
  assert.deepEqual(stripped[1].content, text('answer'))
})

test('applyRange applies the four modes and reports how many were cut', () => {
  const many = Array.from({ length: 250 }, (_, index) => message('user', `m${index}`))
  const auto = applyRange(many, undefined, { maxParentMessages: 200, maxRangeMessages: 1000 })
  assert.equal(auto.messages.length, 200)
  assert.equal(auto.dropped, 50)
  assert.equal(auto.range.mode, 'auto')

  const recent = applyRange(many, { mode: 'recent', recentMessages: 10 })
  assert.equal(recent.messages.length, 10)
  assert.equal(recent.dropped, 240)

  const all = applyRange(many, { mode: 'all' }, { maxRangeMessages: 120 })
  assert.equal(all.messages.length, 120)
  assert.equal(all.dropped, 130)

  const withTools = [message('user', 'hi'), { role: 'tool', content: text('r'), toolCallId: 'c' }]
  const noTools = applyRange(withTools, { mode: 'no-tools' })
  assert.equal(noTools.messages.length, 1)
  assert.equal(noTools.dropped, 1)
})

test('estimateTokens and messagesStats give a stable rough budget', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('hello world'), 3)
  const stats = messagesStats([message('user', '你好'), message('assistant', 'hello world')])
  assert.equal(stats.messages, 2)
  assert.equal(stats.chars, 2 + 'hello world'.length)
  assert.equal(stats.tokens, (4 + 2) + (4 + 3))
})

test('previewContext shares the exact messages and stats with the ask route', () => {
  const snapshotMessages = [message('user', 'a'), message('assistant', 'b'), message('user', 'c')]
  const preview = previewContext(snapshotMessages, { mode: 'recent', recentMessages: 2 })
  assert.equal(preview.messages.length, 2)
  assert.equal(preview.dropped, 1)
  assert.equal(preview.stats.messages, 2)
  assert.deepEqual(preview.range, { mode: 'recent', recentMessages: 2 })
})

test('foldEventsToSnapshot folds a persisted log into model-visible messages', () => {
  const events = [
    {
      seq: 0,
      type: 'request/header',
      data: { header: { config: { provider: 'p', model: 'm' }, tools: [] } },
    },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: message('user', 'question') },
    { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { message: message('assistant', 'answer') } },
    { seq: 3, type: 'turn/end', surfaceOp: 'append', data: { turn: 0, reason: { kind: 'stop' } } },
  ]
  const snapshot = foldEventsToSnapshot(events, 'cold-1')
  assert.equal(snapshot.cold, true)
  assert.equal(snapshot.sessionId, 'cold-1')
  assert.equal(snapshot.messages.length, 2)
  assert.equal(snapshot.messages[0].role, 'user')
  assert.deepEqual(snapshot.header, { config: { provider: 'p', model: 'm' } })
})

test('foldEventsToSnapshot applies surface replacements (compaction-style)', () => {
  const events = [
    { seq: 0, type: 'request/header', data: { header: { config: { provider: 'p', model: 'm' } } } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: message('user', 'old question') },
    { seq: 2, type: 'assistant/message', surfaceOp: 'append', data: { message: message('assistant', 'old answer') } },
    {
      seq: 3,
      type: 'user/message',
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      data: message('user', 'summary of the first turns'),
    },
    { seq: 4, type: 'user/message', surfaceOp: 'append', data: message('user', 'new question') },
  ]
  const snapshot = foldEventsToSnapshot(events, 'cold-2')
  assert.equal(snapshot.messages.length, 2)
  assert.equal(snapshot.messages[0].content[0].text, 'summary of the first turns')
  assert.equal(snapshot.messages[1].content[0].text, 'new question')
})

test('foldEventsToSnapshot drops empty content and keeps the last header', () => {
  const events = [
    { seq: 0, type: 'request/header', data: { header: { config: { provider: 'old', model: 'old' } } } },
    { seq: 1, type: 'request/header', data: { header: { config: { provider: 'new', model: 'new' } } } },
    { seq: 2, type: 'system/message', surfaceOp: 'append', data: { message: { role: 'system', content: [] } } },
    { seq: 3, type: 'user/message', surfaceOp: 'append', data: message('user', 'hi') },
  ]
  const snapshot = foldEventsToSnapshot(events, 'cold-3')
  assert.equal(snapshot.messages.length, 1)
  assert.deepEqual(snapshot.header, { config: { provider: 'new', model: 'new' } })
})

test('foldEventsToSnapshot refuses an empty log', () => {
  assert.throws(() => foldEventsToSnapshot([], 's'), /no events/)
})

test('normaliseDialogMessages keeps only non-empty user/assistant turns', () => {
  const raw = [
    { role: 'user', text: '  what?  ' },
    { role: 'assistant', text: 'because.' },
    { role: 'system', text: 'ignored' },
    { role: 'assistant', text: '   ' },
    null,
  ]
  assert.deepEqual(normaliseDialogMessages(raw), [
    { role: 'user', text: 'what?' },
    { role: 'assistant', text: 'because.' },
  ])
})

test('buildSummaryPrompt includes the four sections, the dialog and the focus quote', () => {
  const prompt = buildSummaryPrompt([
    { role: 'user', text: 'why did the build fail?' },
    { role: 'assistant', text: 'a missing env var' },
  ], { focus: { text: 'the selected line' } })
  assert.match(prompt, /## 我问了什么/)
  assert.match(prompt, /## 结论/)
  assert.match(prompt, /## 关键细节/)
  assert.match(prompt, /## 仍未解决/)
  assert.match(prompt, /why did the build fail\?/)
  assert.match(prompt, /a missing env var/)
  assert.match(prompt, /the selected line/)
  assert.match(prompt, /最多 900 字/)
})

test('buildSummaryPrompt drops the oldest turns when the transcript is over budget', () => {
  const long = 'x'.repeat(7000)
  const prompt = buildSummaryPrompt([
    { role: 'user', text: `old question ${long}` },
    { role: 'assistant', text: `old answer ${long}` },
    { role: 'user', text: 'new question' },
    { role: 'assistant', text: 'new answer' },
  ])
  assert.match(prompt, /较早的 \d+ 条旁问消息因过长已省略/)
  assert.match(prompt, /new question/)
  assert.match(prompt, /new answer/)
  assert.doesNotMatch(prompt, /old question/)
})

test('cleanSummary strips code fences and collapses blank runs', () => {
  assert.equal(cleanSummary('```md\n## a\n\n\n\nb\n```'), '## a\n\nb')
  assert.equal(cleanSummary('   '), '')
  const clipped = cleanSummary('y'.repeat(20), 10)
  assert.equal(clipped.length, 10)
  assert.ok(clipped.endsWith('…'))
})

test('fallbackSummary keeps every question and the opening of each answer', () => {
  const summary = fallbackSummary([
    { role: 'user', text: 'what broke?' },
    { role: 'assistant', text: 'the build broke\n\nlong explanation' },
  ])
  assert.match(summary, /what broke\?/)
  assert.match(summary, /the build broke/)
  assert.doesNotMatch(summary, /long explanation/)
})

test('normaliseSummaryMeta clamps turns and rejects an invalid timestamp', () => {
  const meta = normaliseSummaryMeta({ turns: 2.5, at: 'not-a-date', focus: true })
  assert.equal(meta.turns, 0)
  assert.equal(meta.focus, true)
  assert.ok(!Number.isNaN(Date.parse(meta.at)))
  assert.equal(normaliseSummaryMeta({ turns: 5000 }).turns, 999)
})

test('buildInjectionBody wraps the summary as background, not an instruction', () => {
  const body = buildInjectionBody('## 结论\n- x 是 y', {
    turns: 3,
    at: '2026-11-03T05:00:00.000Z',
    focus: true,
  })
  assert.match(body, /【btw 旁问记录 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}】/)
  assert.match(body, /这不是新的用户指令，无需逐条回复/)
  assert.match(body, /x 是 y/)
  assert.match(body, /共 3 轮旁问/)
  assert.throws(() => buildInjectionBody('   '), /摘要为空/)
})
