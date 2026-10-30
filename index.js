/**
 * Host half of the composer-prediction bundle.
 *
 * One authenticated Fetch route reads the tail of the Session log and asks the model
 * that Session already uses for the user's most likely next instruction. The Client
 * half only renders the answer and turns it into an editable draft.
 */

import { appendFile } from 'node:fs/promises'

export const name = 'composer-predict'

export const inject = ['connection']

/** Route the browser addresses document-relatively. */
const ROUTE_PATH = '/api/composer.predict'

/** Client diagnostics route; only answers while the diagnostic log is enabled. */
const REPORT_PATH = '/api/composer.report'

/** Where the diagnostic log lands, when enabled: next to this module, in the checkout. */
const REPORT_FILE = new URL('./.diagnostics.jsonl', import.meta.url)

/** Per-Session answer cache size; a Session's `seq` invalidates its own entry. */
const CACHE_LIMIT = 64

const DEFAULTS = {
  enabled: true,
  maxContextMessages: 8,
  maxMessageChars: 600,
  maxSuggestionChars: 32,
  maxTokens: 200,
  timeoutMs: 20000,
  cacheTtlMs: 60000,
  provider: '',
  model: '',
  diagnostics: false,
}

/**
 * Register the prediction route and the client diagnostic route.
 * @param ctx - Host context carrying the Web connection.
 * @param config - row configuration from the bundle patch.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const cache = new Map()
  ctx.effect(() => {
    const connection = Reflect.get(ctx, 'connection')
    const disposers = [
      connection.fetch.register({
        path: ROUTE_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handle(ctx, request, settings, cache),
      }),
      connection.fetch.register({
        path: REPORT_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => report(request, settings),
      }),
    ]
    return () => {
      for (const dispose of disposers) Promise.resolve(dispose()).catch(() => {})
    }
  }, 'composer-predict: routes')
  if (settings.diagnostics === true) {
    const line = `${JSON.stringify({ time: new Date().toISOString(), event: 'host-apply', settings })}\n`
    void appendFile(REPORT_FILE, line, 'utf8').catch(() => {})
  }
}

/**
 * Append one diagnostic line when `diagnostics` is on. Silent otherwise.
 * @param settings - resolved plugin settings.
 * @param row - fields to record.
 */
function trace(settings, row) {
  if (settings.diagnostics !== true) return
  const line = `${JSON.stringify({ time: new Date().toISOString(), ...row })}\n`
  void appendFile(REPORT_FILE, line, 'utf8').catch(() => {})
}

/**
 * Append one client diagnostic line.
 * @param request - buffered Fetch request carrying the client snapshot.
 * @param settings - resolved plugin settings.
 * @returns an empty OK response.
 */
async function report(request, settings) {
  if (settings.diagnostics !== true) return new Response(null, { status: 204 })
  let body
  try {
    body = await request.json()
  } catch {
    return json(400, { error: 'invalid-body' })
  }
  const line = `${JSON.stringify({ time: new Date().toISOString(), ...body })}\n`
  try {
    await appendFile(REPORT_FILE, line, 'utf8')
  } catch {
    return json(500, { error: 'write-failed' })
  }
  return new Response(null, { status: 204 })
}

/**
 * Answer one prediction request.
 * @param ctx - Host context.
 * @param request - buffered Fetch request whose body is `{ sessionId }`.
 * @param settings - resolved plugin settings.
 * @param cache - per-Session answer cache.
 * @returns a JSON response; transport failures never surface as 500.
 */
async function handle(ctx, request, settings, cache) {
  if (!settings.enabled) return json(503, { suggestion: null, error: 'disabled' })

  let payload
  try {
    payload = await request.json()
  } catch {
    return json(400, { suggestion: null, error: 'invalid-body' })
  }

  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : ''
  if (sessionId === '') return json(400, { suggestion: null, error: 'missing-session' })

  const session = safe(() => ctx.get('sessions')?.get?.(sessionId))
  if (!session) {
    trace(settings, { event: 'predict-request', sessionId, found: false })
    return json(404, { suggestion: null, error: 'session-not-found' })
  }

  const seq = Number(session.seq) || 0
  const cached = cache.get(sessionId)
  if (cached !== undefined && cached.seq === seq && Date.now() - cached.time < settings.cacheTtlMs) {
    return json(200, { suggestion: cached.suggestion })
  }

  const llm = safe(() => ctx.get('llm'))
  if (!llm) return json(503, { suggestion: null, error: 'llm-unavailable' })

  const route = resolveRoute(ctx, session, settings)
  if (!route) return json(503, { suggestion: null, error: 'model-unavailable' })

  const transcript = buildTranscript(session, settings)
  trace(settings, { event: 'predict-request', sessionId, found: true, transcriptLength: transcript.length })
  if (transcript === '') return json(200, { suggestion: null })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
  const abort = () => controller.abort()
  request.signal?.addEventListener('abort', abort)
  try {
    let text = ''
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: systemPrompt(settings),
      messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
      maxTokens: settings.maxTokens,
      signal: controller.signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk?.type === 'finish' && chunk.reason?.kind !== 'stop') break
    }
    const suggestion = cleanSuggestion(text, settings)
    trace(settings, { event: 'predict-done', sessionId, suggestion, raw: text.slice(0, 120) })
    remember(cache, sessionId, { seq, suggestion, time: Date.now() })
    return json(200, { suggestion })
  } catch (error) {
    trace(settings, { event: 'predict-error', sessionId, message: messageOf(error) })
    return json(200, { suggestion: null, error: messageOf(error) })
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', abort)
  }
}

/**
 * Keep the cache bounded, most recently used last.
 * @param cache - session cache.
 * @param key - Session id.
 * @param entry - cached answer.
 */
function remember(cache, key, entry) {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
}

/**
 * Resolve the model route: explicit config, then the Session's frozen request head,
 * then its last request context, then the process default.
 * @param ctx - Host context.
 * @param session - live Session.
 * @param settings - resolved plugin settings.
 * @returns a provider/model pair, or undefined when none is configured.
 */
function resolveRoute(ctx, session, settings) {
  if (settings.provider !== '' && settings.model !== '') {
    return { provider: settings.provider, model: settings.model }
  }
  const config = safe(() => session.requestHeader()?.config)
  if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
    return { provider: config.provider, model: config.model }
  }
  const context = safe(() => session.requestContext())
  if (typeof context?.provider === 'string' && typeof context?.model === 'string') {
    return { provider: context.provider, model: context.model }
  }
  const selection = safe(() => ctx.get('agentDefaultModel')?.currentSelection?.())
  if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
    return { provider: selection.provider, model: selection.model }
  }
  return undefined
}

/**
 * Render the conversation tail as role-labelled lines.
 * @param session - live Session.
 * @param settings - resolved plugin settings.
 * @returns the prompt body, empty when the Session carries no conversation.
 */
function buildTranscript(session, settings) {
  const messages = safe(() => session.deriveMessages()) ?? []
  const lines = []
  for (const message of messages) {
    if (message?.role !== 'user' && message?.role !== 'assistant') continue
    const blocks = Array.isArray(message.content) ? message.content : []
    const text = blocks
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    const tools = blocks.filter((block) => block?.type === 'tool-call' && typeof block.name === 'string').map((block) => block.name)
    if (text === '' && tools.length === 0) continue
    const label = message.role === 'user' ? '用户' : '助手'
    const toolNote = tools.length === 0 ? '' : `（调用工具：${[...new Set(tools)].join('、')}）`
    lines.push(`${label}: ${clip(text, settings.maxMessageChars)}${toolNote}`)
  }
  if (lines.length === 0) return ''
  const tail = lines.slice(-Math.max(1, settings.maxContextMessages))
  const cwd = safe(() => session.header?.cwd)
  const where = typeof cwd === 'string' && cwd !== '' ? `工作目录：${cwd}\n\n` : ''
  return `${where}对话尾部：\n${tail.join('\n')}\n\n请只输出用户的下一条指令。只有对话没有任何实质内容时才输出 NONE。`
}

/**
 * The instruction block for one prediction call.
 * @param settings - resolved plugin settings.
 * @returns the system prompt.
 */
function systemPrompt(settings) {
  const limit = settings.maxSuggestionChars
  return [
    '你是一个编码智能体的「下一步指令预测器」。',
    '阅读给出的对话尾部，预测用户此刻最可能直接发送的下一条指令。',
    '',
    '规则：',
    '- 使用对话本身的语言（对话以中文为主就用中文，以英文为主就用英文）。',
    `- 只输出一条指令：具体、可执行，不超过 ${limit} 个汉字或 ${limit} 个英文单词。`,
    '- 只输出指令本身：不要引号、不要编号、不要句末句号、不要解释、不要换行。',
    '- 给出紧接着的下一步：运行或验证、修复报错、补充测试、继续实现、调整样式、打开结果。',
    '- 不要复述用户上一句，也不要给出与当前任务无关的通用建议。',
    '- 永远给出最佳猜测：只要对话里有任务上下文，就输出一条你认为最可能的指令。',
    '- 只有当对话没有任何实质内容（例如只有问候）时才输出 NONE。',
  ].join('\n')
}

/**
 * Narrow the model reply to one editable instruction.
 * @param text - accumulated model text.
 * @param settings - resolved plugin settings.
 * @returns the instruction, or null when the model declined.
 */
function cleanSuggestion(text, settings) {
  if (typeof text !== 'string') return null
  const line = text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '')
  if (line === undefined) return null
  let value = line
    .replace(/^[-*•\d.、)）\s]+/u, '')
    .replace(/^["'“”‘’`「」《》]+|["'“”‘’`「」《》]+$/gu, '')
    .trim()
  if (value === '') return null
  if (/^(none|n\/a|无|没有|无法预测)$/iu.test(value)) return null
  const cap = Math.max(8, settings.maxSuggestionChars * 3)
  if (value.length > cap) value = value.slice(0, cap)
  return value
}

/**
 * Keep the head and tail of one long message.
 * @param text - message text.
 * @param limit - maximum characters.
 * @returns the clipped text.
 */
function clip(text, limit) {
  if (typeof text !== 'string') return ''
  if (limit <= 0 || text.length <= limit) return text
  const head = Math.max(1, Math.floor(limit * 0.7))
  const tail = Math.max(1, Math.floor(limit * 0.25))
  return `${text.slice(0, head)} … ${text.slice(-tail)}`
}

/**
 * Read a value without letting an unavailable capability break the route.
 * @param read - thunk returning the value.
 * @returns the value or undefined.
 */
function safe(read) {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Describe an error for the Client, which only logs it.
 * @param error - thrown value.
 * @returns a short message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Build one JSON response.
 * @param status - HTTP status.
 * @param body - JSON-serializable body.
 * @returns the response.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Merge row configuration over the defaults.
 * @param config - row configuration.
 * @returns resolved settings.
 */
function resolveSettings(config) {
  const merged = { ...DEFAULTS }
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!(key in DEFAULTS)) continue
    if (typeof DEFAULTS[key] === 'number') {
      const number = Number(value)
      if (Number.isFinite(number) && number >= 0) merged[key] = number
      continue
    }
    if (typeof DEFAULTS[key] === 'boolean') {
      merged[key] = value === true || value === 'true'
      continue
    }
    if (typeof value === 'string') merged[key] = value
  }
  return merged
}
