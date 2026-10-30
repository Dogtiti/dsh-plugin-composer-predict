import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../index.js'

const SESSION_ID = 'session-test'

/**
 * Build one live-Session stand-in with the fields the route reads.
 * @param seq - current event sequence.
 * @returns a fake Session.
 */
function fakeSession(seq = 7) {
  return {
    seq,
    header: { cwd: '/tmp/project' },
    deriveMessages: () => [
      { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'ignored' }] },
      { role: 'user', content: [{ type: 'text', text: '帮我做一个登录页' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '登录页已经写好，表单校验也加上了。' },
          { type: 'tool-call', id: 'c1', name: 'edit', arguments: '{}' },
          { type: 'tool-call', id: 'c2', name: 'edit', arguments: '{}' },
        ],
      },
    ],
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'high' } }),
    requestContext: () => ({ provider: 'test-provider', model: 'test-model' }),
  }
}

/**
 * Build a Host context stand-in that records the registered route.
 * @param options - fake services and captured calls.
 * @returns `{ ctx, route, calls }`.
 */
function fakeHost(options = {}) {
  const calls = { streams: 0, requests: [] }
  const session = options.session ?? fakeSession()
  const route = { current: undefined }
  const ctx = {
    effect(callback) {
      const dispose = callback()
      return dispose
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => (id === SESSION_ID ? session : undefined) }
      if (name === 'llm') {
        return {
          stream(request) {
            calls.streams += 1
            calls.requests.push(request)
            return (async function* () {
              yield { type: 'text-delta', text: options.reply ?? '“跑一下测试”' }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
      return undefined
    },
  }
  ctx.connection = {
    fetch: {
      register(definition) {
        if (definition.path === '/api/composer.predict') route.current = definition
        else route.extra = definition
        return () => {}
      },
    },
  }
  return { ctx, route, calls, session }
}

/**
 * Call the registered route.
 * @param route - the captured route.
 * @param body - JSON body.
 * @returns the response.
 */
async function post(route, body) {
  return route.current.fetch(
    new Request('http://127.0.0.1:1/api/composer.predict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('registers one POST route', () => {
  const { ctx, route } = fakeHost()
  apply(ctx, {})
  assert.equal(route.current.path, '/api/composer.predict')
  assert.deepEqual(route.current.methods, ['POST'])
})

test('rejects a body without a session id', async () => {
  const { ctx, route } = fakeHost()
  apply(ctx, {})
  const response = await post(route, {})
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'missing-session')
})

test('reports an unknown session', async () => {
  const { ctx, route } = fakeHost()
  apply(ctx, {})
  const response = await post(route, { sessionId: 'session-other' })
  assert.equal(response.status, 404)
})

test('predicts through the session model and strips quoting', async () => {
  const { ctx, route, calls } = fakeHost()
  apply(ctx, {})
  const response = await post(route, { sessionId: SESSION_ID })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { suggestion: '跑一下测试' })
  assert.equal(calls.streams, 1)
  const request = calls.requests[0]
  assert.equal(request.provider, 'test-provider')
  assert.equal(request.model, 'test-model')
  assert.match(request.messages[0].content[0].text, /用户: 帮我做一个登录页/)
  assert.match(request.messages[0].content[0].text, /调用工具：edit/)
  assert.match(request.messages[0].content[0].text, /工作目录：\/tmp\/project/)
})

test('treats NONE as no suggestion', async () => {
  const { ctx, route } = fakeHost({ reply: 'NONE' })
  apply(ctx, {})
  assert.deepEqual(await (await post(route, { sessionId: SESSION_ID })).json(), { suggestion: null })
})

test('serves a repeated question from cache until the session advances', async () => {
  const { ctx, route, calls, session } = fakeHost()
  apply(ctx, {})
  await post(route, { sessionId: SESSION_ID })
  await post(route, { sessionId: SESSION_ID })
  assert.equal(calls.streams, 1)
  session.seq = 8
  await post(route, { sessionId: SESSION_ID })
  assert.equal(calls.streams, 2)
})

test('honours an explicit model override and the disabled switch', async () => {
  const overridden = fakeHost()
  apply(overridden.ctx, { provider: 'cfg-provider', model: 'cfg-model' })
  await post(overridden.route, { sessionId: SESSION_ID })
  assert.equal(overridden.calls.requests[0].provider, 'cfg-provider')

  const disabled = fakeHost()
  apply(disabled.ctx, { enabled: false })
  const response = await post(disabled.route, { sessionId: SESSION_ID })
  assert.equal(response.status, 503)
  assert.equal(disabled.calls.streams, 0)
})

test('the prompt keeps NONE as a last resort, not an easy exit', async () => {
  const { ctx, route, calls } = fakeHost()
  apply(ctx, {})
  await post(route, { sessionId: SESSION_ID })
  const system = calls.requests[0].system
  /* Offered an escape hatch, the model takes it and the composer stays silent. */
  assert.match(system, /永远给出最佳猜测/)
  assert.match(system, /只有当对话没有任何实质内容/)
  assert.doesNotMatch(system, /如果确实无法预测/)
  assert.match(calls.requests[0].messages[0].content[0].text, /只有对话没有任何实质内容时才输出 NONE/)
})
