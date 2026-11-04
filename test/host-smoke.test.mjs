/**
 * Smoke test for the host half: wires a fake Cordis context and a fake HTTP
 * request/response, then drives all three routes end to end (admission fence,
 * JSON body, session snapshot, context preview, SSE streaming, cold sessions).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Readable, Writable } from 'node:stream'

import * as plugin from '../lib/index.js'

test('plugin version matches package.json (no drift on release)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(plugin.VERSION, pkg.version)
})

class FakeRequest extends Readable {
  constructor(body) {
    super()
    this.method = 'POST'
    this.headers = { 'content-type': 'application/json' }
    if (body !== undefined) this.push(Buffer.from(JSON.stringify(body)))
    this.push(null)
  }
}

class FakeResponse extends Writable {
  constructor() {
    super()
    this.status = 0
    this.headers = null
    this.chunks = []
  }

  writeHead(status, headers) {
    this.status = status
    this.headers = headers || null
    return this
  }

  flushHeaders() {}

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
    callback()
  }

  get text() {
    return this.chunks.join('')
  }
}

const userMessage = { role: 'user', content: [{ type: 'text', text: 'parent question' }] }

function fakeSession() {
  return {
    id: 'session-1',
    requestHeader: () => ({ config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } }),
    deriveMessages: () => [userMessage],
    toolHistory: () => undefined,
  }
}

/** A tiny persisted log: request header + one user + one assistant message. */
function fakePersistedEvents() {
  return [
    { seq: 0, type: 'request/header', data: { header: { config: { provider: 'persisted', model: 'cold-model' } } } },
    {
      seq: 1,
      type: 'user/message',
      surfaceOp: 'append',
      data: { role: 'user', content: [{ type: 'text', text: 'persisted question' }] },
    },
    {
      seq: 2,
      type: 'assistant/message',
      surfaceOp: 'append',
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'persisted answer' }] } },
    },
  ]
}

/** Wire apply() and return the registered routes. */
function start({
  rejection = undefined,
  session = fakeSession(),
  query = undefined,
  persistence = undefined,
  agents = undefined,
  config = {},
  chunks = [
    { type: 'text-delta', index: 0, text: 'answer' },
    { type: 'usage', usage: { input: 1, output: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
} = {}) {
  const routes = new Map()
  const calls = []
  const services = {
    sessionQuery: query,
    sessionPersistence: persistence,
    agents,
    sessions: { get: (id) => (id === 'session-1' ? session : undefined) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) },
  }
  const ctx = {
    effect(fn) {
      const disposer = fn()
      return () => { if (typeof disposer === 'function') disposer() }
    },
    get(name) {
      return services[name]
    },
    sessions: services.sessions,
    connection: { requestRejection: () => rejection },
    llm: {
      listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }, { id: 'other', name: 'Other' }],
      listModels: async (provider) => (provider === 'opencode-go'
        ? [{ provider: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' }]
        : [{ provider: 'other', id: 'glm-5.3', name: 'GLM 5.3' }]),
      resolveModelInfo: async (provider, model) => {
        if (provider === 'opencode-go' || provider === 'other') return { provider, id: model }
        throw new Error(`unknown route ${provider}/${model}`)
      },
      stream(options) {
        calls.push(options)
        return (async function* generate() {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }
  plugin.apply(ctx, { ...config })
  return { routes, calls }
}

async function invoke(handler, request) {
  const response = new FakeResponse()
  await handler(request, response)
  return response
}

function sseEvents(text) {
  return text
    .split('\n\n')
    .map(frame => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      const event = /^event: (.*)$/m.exec(frame)?.[1]
      const data = /^data: (.*)$/m.exec(frame)?.[1]
      return { event, data: data ? JSON.parse(data) : undefined }
    })
}

test('apply registers all routes and exports the expected metadata', () => {
  const { routes } = start()
  assert.deepEqual([...routes.keys()].sort(), ['/btw/ask', '/btw/commit', '/btw/context', '/btw/health', '/btw/models', '/btw/summarize'])
  assert.equal(plugin.name, 'dsh-btw-plugin')
  assert.equal(plugin.VERSION, '0.5.6')
  assert.deepEqual(plugin.inject, ['webServer', 'llm', 'sessions', 'connection'])
})

test('GET /btw/health reports config after the admission fence', async () => {
  const { routes } = start()
  const request = new FakeRequest()
  request.method = 'GET'
  const response = await invoke(routes.get('/btw/health'), request)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-btw-plugin')
  assert.equal(body.version, '0.5.6')
  assert.equal(body.coldRead, 'none')
  assert.deepEqual(body.defaultRoute, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.equal(body.config.toolParity, false)
  assert.equal(body.config.maxRangeMessages, 1000)
  assert.equal(body.config.maxSummaryChars, 8000)
})

test('health route is rejected when the host admission policy says no', async () => {
  const { routes } = start({ rejection: 403 })
  const request = new FakeRequest()
  request.method = 'GET'
  const response = await invoke(routes.get('/btw/health'), request)
  assert.equal(response.status, 403)
  assert.equal(JSON.parse(response.text).error.code, 'FORBIDDEN')
})

test('POST /btw/context previews the range without calling the model', async () => {
  const { routes, calls } = start()
  const request = new FakeRequest({ sessionId: 'session-1', question: 'ignored' })
  const response = await invoke(routes.get('/btw/context'), request)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.equal(body.cold, false)
  assert.equal(body.stats.messages, 1)
  assert.ok(body.stats.tokens > 0)
  assert.equal(body.dropped, 0)
  assert.deepEqual(body.range, { mode: 'auto', recentMessages: 40 })
  assert.equal(body.provider, 'opencode-go')
  assert.equal(body.model, 'deepseek-v4.1-flash')
  assert.equal(calls.length, 0)
})

test('POST /btw/context reports dropped messages for a small recent range', async () => {
  const session = fakeSession()
  session.deriveMessages = () => Array.from({ length: 8 }, (_, index) => ({
    role: 'user',
    content: [{ type: 'text', text: `turn ${index}` }],
  }))
  const { routes } = start({ session })
  const response = await invoke(routes.get('/btw/context'), new FakeRequest({
    sessionId: 'session-1',
    range: { mode: 'recent', recentMessages: 3 },
  }))
  const body = JSON.parse(response.text)
  assert.equal(body.stats.messages, 3)
  assert.equal(body.dropped, 5)
})

test('POST /btw/context rejects an unknown session', async () => {
  const { routes } = start()
  const response = await invoke(routes.get('/btw/context'), new FakeRequest({ sessionId: 'missing' }))
  assert.equal(response.status, 404)
  assert.equal(JSON.parse(response.text).error.code, 'SESSION_NOT_LIVE')
})

test('POST /btw/ask streams meta + one answer from a snapshot', async () => {
  const { routes, calls } = start()
  const request = new FakeRequest({
    sessionId: 'session-1',
    question: 'what happened?',
    range: { mode: 'recent', recentMessages: 10 },
  })
  const response = await invoke(routes.get('/btw/ask'), request)

  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /text\/event-stream/)
  const events = sseEvents(response.text)
  assert.deepEqual(events.map(event => event.event), ['meta', 'delta', 'usage', 'done'])
  assert.equal(events[0].data.cold, false)
  assert.equal(events[0].data.stats.messages, 1)
  assert.deepEqual(events[0].data.range, { mode: 'recent', recentMessages: 10 })
  assert.equal(events[1].data.text, 'answer')
  assert.equal(events[3].data.text, 'answer')
  assert.equal(events[3].data.truncated, false)
  assert.equal(events[3].data.stats.messages, 1)

  assert.equal(calls.length, 1)
  const options = calls[0]
  assert.equal(options.provider, 'opencode-go')
  assert.equal(options.model, 'deepseek-v4.1-flash')
  assert.equal(options.sessionId, 'session-1')
  assert.equal(options.messages[0], userMessage)
  assert.match(options.messages[1].content[0].text, /what happened\?$/)
  assert.match(options.messages[1].content[0].text, /Do not call any tool/)
  assert.equal(options.tools, undefined) // default (no parity mode): plain Q&A
})

test('POST /btw/ask rejects an unknown live session', async () => {
  const { routes } = start()
  const request = new FakeRequest({ sessionId: 'missing', question: 'why?' })
  const response = await invoke(routes.get('/btw/ask'), request)
  assert.equal(response.status, 404)
  assert.equal(JSON.parse(response.text).error.code, 'SESSION_NOT_LIVE')
})

test('POST /btw/ask quotes a text selection ahead of the question', async () => {
  const { routes, calls } = start()
  const response = await invoke(routes.get('/btw/ask'), new FakeRequest({
    sessionId: 'session-1',
    question: 'explain this',
    focus: { kind: 'selection', text: '  the selected sentence  ' },
  }))
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
  const prompt = calls[0].messages.at(-1).content[0].text
  assert.match(prompt, /用户选中的文本/)
  assert.match(prompt, /the selected sentence/)
  assert.match(prompt, /explain this$/)
})

test('POST /btw/ask resolves a message focus against the full snapshot', async () => {
  const withIds = {
    ...fakeSession(),
    deriveMessages: () => [
      { id: 'm1', role: 'user', content: [{ type: 'text', text: 'parent question' }] },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: 'the referenced answer' }] },
    ],
  }
  const { routes, calls } = start({ session: withIds })
  const response = await invoke(routes.get('/btw/ask'), new FakeRequest({
    sessionId: 'session-1',
    question: 'why that?',
    focus: { kind: 'message', messageId: 'm2' },
  }))
  assert.equal(response.status, 200)
  const prompt = calls[0].messages.at(-1).content[0].text
  assert.match(prompt, /会话中的一条 assistant 消息/)
  assert.match(prompt, /the referenced answer/)
  assert.match(prompt, /why that\?$/)
})

test('POST /btw/ask ignores an unknown focus message id instead of failing', async () => {
  const { routes, calls } = start()
  const response = await invoke(routes.get('/btw/ask'), new FakeRequest({
    sessionId: 'session-1',
    question: 'still useful',
    focus: { kind: 'message', messageId: 'missing' },
  }))
  assert.equal(response.status, 200)
  const prompt = calls[0].messages.at(-1).content[0].text
  assert.doesNotMatch(prompt, /用户正在针对/)
  assert.match(prompt, /still useful$/)
})

test('POST /btw/ask rejects a missing or empty body', async () => {
  const { routes } = start()
  const request = new FakeRequest({ sessionId: 'session-1', question: '   ' })
  const response = await invoke(routes.get('/btw/ask'), request)
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.text).error.code, 'BAD_REQUEST')
})

test('POST /btw/ask surfaces a failed finish as an SSE error frame', async () => {
  const { routes } = start({
    chunks: [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT' } } }],
  })
  const request = new FakeRequest({ sessionId: 'session-1', question: 'why?' })
  const response = await invoke(routes.get('/btw/ask'), request)
  const events = sseEvents(response.text)
  assert.deepEqual(events.map(event => event.event), ['meta', 'error'])
  assert.equal(events[1].data.code, 'RATE_LIMIT')
})

test('POST /btw/ask rejects invalid JSON, oversized bodies, wrong methods and missing questions', async () => {
  const { routes } = start({ config: { maxBodyBytes: 64 } })

  const getRequest = new FakeRequest()
  getRequest.method = 'GET'
  const getAttempt = await invoke(routes.get('/btw/ask'), getRequest)
  assert.equal(getAttempt.status, 405)

  const badJson = await invoke(routes.get('/btw/ask'), new FakeRequest('{not json'))
  assert.equal(badJson.status, 400)
  assert.equal(JSON.parse(badJson.text).error.code, 'BAD_REQUEST')

  const oversized = await invoke(routes.get('/btw/ask'), new FakeRequest('x'.repeat(200)))
  assert.equal(oversized.status, 413)

  const noQuestion = await invoke(routes.get('/btw/ask'), new FakeRequest({ sessionId: 'session-1' }))
  assert.equal(noQuestion.status, 400)
  assert.equal(JSON.parse(noQuestion.text).error.message, 'question is required')
})

test('GET /btw/models lists providers, the session route, and the harness default', async () => {
  const { routes } = start()
  const request = new FakeRequest()
  request.method = 'GET'
  request.url = '/btw/models?sessionId=session-1'
  const response = await invoke(routes.get('/btw/models'), request)
  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.deepEqual(body.providers.map((provider) => provider.id), ['opencode-go', 'other'])
  assert.equal(body.providers[0].models[0].id, 'deepseek-v4.1-flash')
  assert.deepEqual(body.current, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(body.default, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
})

test('POST /btw/ask honours an explicit model pick and per-call settings', async () => {
  const { routes, calls } = start()
  const response = await invoke(routes.get('/btw/ask'), new FakeRequest({
    sessionId: 'session-1',
    question: 'compare',
    provider: 'other',
    model: 'glm-5.3',
    temperature: 0.4,
    maxTokens: 512,
    reasoningEffort: 'low',
  }))
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'other')
  assert.equal(calls[0].model, 'glm-5.3')
  assert.equal(calls[0].temperature, 0.4)
  assert.equal(calls[0].maxTokens, 512)
  assert.equal(calls[0].reasoningEffort, 'low')
  const meta = sseEvents(response.text)[0]
  assert.equal(meta.event, 'meta')
  assert.equal(meta.data.provider, 'other')
  assert.equal(meta.data.model, 'glm-5.3')
})

test('POST /btw/ask rejects an unregistered model pick before streaming', async () => {
  const { routes, calls } = start()
  const response = await invoke(routes.get('/btw/ask'), new FakeRequest({
    sessionId: 'session-1',
    question: 'x',
    provider: 'missing',
    model: 'nope',
  }))
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.text).error.code, 'BAD_MODEL')
  assert.equal(calls.length, 0)
})

test('GET /btw/models is fenced too', async () => {
  const { routes } = start({ rejection: 401 })
  const request = new FakeRequest()
  request.method = 'GET'
  request.url = '/btw/models'
  const response = await invoke(routes.get('/btw/models'), request)
  assert.equal(response.status, 401)
})

test('POST /btw/summarize compresses the dialog with a fixed low-temperature request', async () => {
  const { routes, calls } = start()
  const response = await invoke(routes.get('/btw/summarize'), new FakeRequest({
    sessionId: 'session-1',
    messages: [
      { role: 'user', text: 'what is x?' },
      { role: 'assistant', text: 'x is y' },
    ],
  }))
  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.equal(body.summary, 'answer')
  assert.equal(body.provider, 'opencode-go')
  assert.equal(body.model, 'deepseek-v4.1-flash')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].temperature, 0.2)
  assert.equal(calls[0].maxTokens, 1200)
  assert.match(calls[0].messages[0].content[0].text, /what is x\?/)
  assert.match(calls[0].messages[0].content[0].text, /我问了什么/)
})

test('POST /btw/summarize falls back to a local digest when the model returns nothing', async () => {
  const { routes } = start({ chunks: [] })
  const response = await invoke(routes.get('/btw/summarize'), new FakeRequest({
    sessionId: 'session-1',
    messages: [
      { role: 'user', text: 'what broke?' },
      { role: 'assistant', text: 'the build broke' },
    ],
  }))
  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.fallback, true)
  assert.match(body.summary, /what broke\?/)
  assert.match(body.summary, /the build broke/)
  assert.ok(body.warning)
})

test('POST /btw/summarize rejects an empty dialog', async () => {
  const { routes } = start()
  const response = await invoke(routes.get('/btw/summarize'), new FakeRequest({
    sessionId: 'session-1',
    messages: [{ role: 'assistant', text: '   ' }],
  }))
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.text).error.code, 'BAD_REQUEST')
})

test('POST /btw/commit appends a context message without waking a turn', async () => {
  const appended = []
  const session = fakeSession()
  session.append = (type, data, options) => {
    appended.push({ type, data, options })
    return { seq: 42 }
  }
  const { routes } = start({ session })
  const response = await invoke(routes.get('/btw/commit'), new FakeRequest({
    sessionId: 'session-1',
    summary: '## 结论\n- x 是 y',
    turns: 2,
    at: '2026-11-03T05:00:00.000Z',
  }))
  assert.equal(response.status, 200)
  const body = JSON.parse(response.text)
  assert.equal(body.ok, true)
  assert.equal(body.seq, 42)
  assert.equal(appended.length, 1)
  const [event] = appended
  assert.equal(event.type, 'user/message')
  assert.equal(event.options.surfaceOp, 'append')
  assert.equal(event.data.role, 'user')
  assert.equal(event.data.source.kind, 'btw')
  assert.equal(event.data.source.form, 'notice')
  assert.equal(event.data.source.turns, 2)
  assert.match(event.data.content[0].text, /【btw 旁问记录/)
  assert.match(event.data.content[0].text, /x 是 y/)
  assert.match(event.data.content[0].text, /不是新的用户指令/)
})

test('POST /btw/commit refuses a session that is not live', async () => {
  const { routes } = start()
  const response = await invoke(routes.get('/btw/commit'), new FakeRequest({
    sessionId: 'missing',
    summary: 'a summary',
  }))
  assert.equal(response.status, 409)
  assert.equal(JSON.parse(response.text).error.code, 'SESSION_NOT_LIVE')
})

test('POST /btw/commit refuses while the parent agent is running', async () => {
  const session = fakeSession()
  session.append = () => ({ seq: 1 })
  const { routes } = start({ session, agents: { get: () => ({ status: 'running' }) } })
  const response = await invoke(routes.get('/btw/commit'), new FakeRequest({
    sessionId: 'session-1',
    summary: 'a summary',
  }))
  assert.equal(response.status, 409)
  assert.equal(JSON.parse(response.text).error.code, 'SESSION_BUSY')
})

test('POST /btw/commit validates the summary size', async () => {
  const session = fakeSession()
  session.append = () => ({ seq: 1 })
  const { routes } = start({ session, config: { maxSummaryChars: 20 } })
  const response = await invoke(routes.get('/btw/commit'), new FakeRequest({
    sessionId: 'session-1',
    summary: 'x'.repeat(21),
  }))
  assert.equal(response.status, 400)
  assert.equal(JSON.parse(response.text).error.code, 'BAD_REQUEST')
})

test('cold sessions are folded from ctx.sessionQuery', async () => {
  const events = fakePersistedEvents()
  const query = { readSession: async (id) => (id === 'cold-1' ? { events } : Promise.reject(new Error('not found'))) }
  const { routes, calls } = start({ query })

  const preview = await invoke(routes.get('/btw/context'), new FakeRequest({ sessionId: 'cold-1' }))
  assert.equal(preview.status, 200)
  const previewBody = JSON.parse(preview.text)
  assert.equal(previewBody.cold, true)
  assert.equal(previewBody.stats.messages, 2)
  assert.equal(previewBody.provider, 'persisted')

  const answer = await invoke(routes.get('/btw/ask'), new FakeRequest({ sessionId: 'cold-1', question: 'summarise' }))
  const eventsSeen = sseEvents(answer.text)
  assert.equal(eventsSeen[0].event, 'meta')
  assert.equal(eventsSeen[0].data.cold, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'persisted')
  assert.equal(calls[0].model, 'cold-model')
  assert.equal(calls[0].messages.length, 3)
  assert.equal(calls[0].messages[0].content[0].text, 'persisted question')
})

test('cold read failure is reported instead of pretending the session is live', async () => {
  const query = {
    readSession: async () => {
      const error = new Error('session record is absent')
      error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
      throw error
    },
  }
  const { routes } = start({ query })
  const response = await invoke(routes.get('/btw/context'), new FakeRequest({ sessionId: 'cold-missing' }))
  assert.equal(response.status, 404)
  assert.equal(JSON.parse(response.text).error.code, 'SESSION_NOT_LIVE')
})
