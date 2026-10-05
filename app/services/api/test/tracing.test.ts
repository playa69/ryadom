/**
 * Tracing headers: the API takes the five headers, writes them to the request log and passes them to
 * the agent; the account behind a token is the one thing the client's word does not decide.
 */
import { Writable } from 'node:stream'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import { requestContextLogFields, TRACING_HEADERS } from '@ryadom/core/shared'
import { DialogMode } from '@ryadom/contracts/api/dialogs'
import { TracingHeader } from '@ryadom/contracts/api/headers'
import { call, json, makeApp, mockAgent, ok, signUpAndIn } from './helpers'

/** A real pino logger with the core's mixin, writing to memory, so that the request log can be read back. */
function capturingLogger() {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)) as Record<string, unknown>)
      done()
    },
  })
  return { logger: pino({ level: 'info', mixin: requestContextLogFields }, stream), lines }
}

const { logger, lines } = capturingLogger()
const { app, resetLimits } = makeApp({ logger })

const CLIENT_HEADERS = {
  'x-trace-id': 'trace-abc-123',
  'x-request-time': '2026-10-04T10:00:00.000Z',
  'x-client-id': 'ryadom-web',
  'x-session-id': 'session-1',
}

async function startDialog(token: string, headers: Record<string, string> = {}) {
  return call(app, 'POST', '/api/dialogs', { mode: DialogMode.Vent }, token, headers)
}

describe('имена заголовков', () => {
  it('в ядре и в контрактах одни и те же', () => {
    expect(Object.values(TRACING_HEADERS).sort()).toEqual(Object.values(TracingHeader).sort())
  })
})

describe('передача агенту', () => {
  it('заголовки клиента доходят до агента как есть, а userId — проверенный, не присланный', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const { calls } = mockAgent()

    ok(await startDialog(tokens.accessToken, { ...CLIENT_HEADERS, 'x-user-id': 'forged-user' }))

    const sent = calls.at(-1)!.headers
    expect(sent.get('x-trace-id')).toBe('trace-abc-123')
    expect(sent.get('x-request-time')).toBe('2026-10-04T10:00:00.000Z')
    expect(sent.get('x-client-id')).toBe('ryadom-web')
    expect(sent.get('x-session-id')).toBe('session-1')
    expect(sent.get('x-user-id')).toBe(user.id)
  })

  it('без заголовков агенту уходят все пять пустыми: trace id не выдумывается', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    const { calls } = mockAgent()

    ok(await startDialog(tokens.accessToken))

    const sent = calls.at(-1)!.headers
    for (const name of ['x-trace-id', 'x-request-time', 'x-client-id', 'x-session-id']) {
      expect(sent.has(name), name).toBe(true)
      expect(sent.get(name), name).toBe('')
    }
    expect(sent.get('x-user-id')).toBe(user.id)
  })

  it('непригодные значения отбрасываются и не ломают вызов агента', async () => {
    resetLimits()
    const { tokens } = await signUpAndIn(app)
    const { calls } = mockAgent()

    // fetch refuses a header value outside printable ASCII, so forwarding one as is would fail the call.
    ok(
      await startDialog(tokens.accessToken, {
        'x-trace-id': 'café',
        'x-client-id': 'c'.repeat(129),
        'x-session-id': 'session-1',
      }),
    )

    const sent = calls.at(-1)!.headers
    expect(sent.get('x-trace-id')).toBe('')
    expect(sent.get('x-client-id')).toBe('')
    expect(sent.get('x-session-id')).toBe('session-1')
  })

  it('параллельные запросы не путают контексты', async () => {
    resetLimits()
    const first = await signUpAndIn(app)
    const second = await signUpAndIn(app)
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    // The first request answers last, so the second one has to finish inside its context.
    const { calls } = mockAgent({
      'POST http://agent.test/v1/users/*/dialogs': async ({ url }) => {
        await delay(url.pathname.includes(first.user.id) ? 40 : 1)
        return json({ dialogId: 'd-1', resumed: false })
      },
    })

    await Promise.all([
      startDialog(first.tokens.accessToken, { 'x-trace-id': 'trace-first' }),
      startDialog(second.tokens.accessToken, { 'x-trace-id': 'trace-second' }),
    ])

    const traceOf = (userId: string) =>
      calls.find((sent) => sent.url.pathname.includes(userId))!.headers.get('x-trace-id')
    expect(traceOf(first.user.id)).toBe('trace-first')
    expect(traceOf(second.user.id)).toBe('trace-second')
  })
})

describe('запись о запросе в логе', () => {
  const requestEntry = (path: string) =>
    lines.filter((line) => line.msg === 'request' && line.path === path).at(-1)!

  it('несёт поля трассировки и проверенного пользователя', async () => {
    resetLimits()
    const { user, tokens } = await signUpAndIn(app)
    mockAgent()

    ok(await startDialog(tokens.accessToken, { ...CLIENT_HEADERS, 'x-user-id': 'forged-user' }))

    expect(requestEntry('/api/dialogs')).toMatchObject({
      rqUId: 'trace-abc-123',
      rqTime: '2026-10-04T10:00:00.000Z',
      systemId: 'ryadom-web',
      gwSessionId: 'session-1',
      userId: user.id,
    })
  })

  it('без заголовков не содержит rqUId', async () => {
    resetLimits()
    const response = await app.request('/api/health')
    expect(response.status).toBe(200)
    // Health is logged at debug, so look at a request that is logged at info.
    await app.request('/api/no-such-route')
    expect(requestEntry('/api/no-such-route')).not.toHaveProperty('rqUId')
  })
})

describe('CORS', () => {
  it('разрешает заголовки трассировки: веб-приложение шлёт их с другого origin', async () => {
    const response = await app.request('/api/dialogs', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example.test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': Object.values(TracingHeader).join(','),
      },
    })
    const allowed = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    for (const name of Object.values(TracingHeader)) expect(allowed).toContain(name)
  })
})
