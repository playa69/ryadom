/**
 * Tracing context: the five headers are read once at the entry, and log records and outgoing calls
 * pick them up from AsyncLocalStorage.
 */
import { EventEmitter } from 'node:events'
import { symbols } from 'pino'
import { describe, expect, it } from 'vitest'
import {
  bindRequestContext,
  getRequestContext,
  getRootLogger,
  readTracingContext,
  requestContextLogFields,
  runWithRequestContext,
  tracingHeaders,
  updateRequestContext,
} from '../src/shared'

const FULL = {
  'x-trace-id': 'trace-abc-123',
  'x-request-time': '2026-10-04T10:00:00.000Z',
  'x-client-id': 'ryadom-web',
  'x-session-id': 'session-1',
  'x-user-id': 'user-1',
}

const fromObject = (headers: Record<string, string | string[]>) => (name: string) => headers[name]

describe('чтение заголовков', () => {
  it('берёт пять заголовков под их именами в логе', () => {
    expect(readTracingContext(fromObject(FULL))).toEqual({
      rqUId: 'trace-abc-123',
      rqTime: '2026-10-04T10:00:00.000Z',
      systemId: 'ryadom-web',
      gwSessionId: 'session-1',
      userId: 'user-1',
    })
  })

  it('без x-trace-id rqUId не появляется: сервис его не выдумывает', () => {
    const { 'x-trace-id': _omitted, ...rest } = FULL
    const context = readTracingContext(fromObject(rest))
    expect(context).not.toHaveProperty('rqUId')
    expect(context.systemId).toBe('ryadom-web')
  })

  it('пустое, слишком длинное и не ASCII значение считается отсутствующим', () => {
    const context = readTracingContext(
      fromObject({
        'x-trace-id': '   ',
        'x-request-time': 'x'.repeat(129),
        'x-client-id': 'café',
        'x-session-id': 'two\nlines',
        'x-user-id': 'ok-user',
      }),
    )
    expect(context).toEqual({ userId: 'ok-user' })
  })

  it('граница длины: 128 символов проходят', () => {
    expect(readTracingContext(fromObject({ 'x-trace-id': 'a'.repeat(128) })).rqUId).toHaveLength(128)
  })

  it('из повторяющегося заголовка берётся первое значение, пробелы по краям срезаются', () => {
    const context = readTracingContext(fromObject({ 'x-trace-id': [' first ', 'second'] }))
    expect(context.rqUId).toBe('first')
  })
})

describe('контекст запроса', () => {
  it('вне запроса пуст, а исходящие заголовки идут все пять и пустыми', () => {
    expect(getRequestContext()).toEqual({})
    expect(tracingHeaders()).toEqual({
      'x-trace-id': '',
      'x-request-time': '',
      'x-client-id': '',
      'x-session-id': '',
      'x-user-id': '',
    })
  })

  it('внутри запроса исходящие заголовки несут текущие значения', () => {
    const headers = runWithRequestContext(readTracingContext(fromObject(FULL)), () => tracingHeaders())
    expect(headers).toEqual(FULL)
  })

  it('updateRequestContext дополняет контекст, и это видно во всём запросе', async () => {
    await runWithRequestContext(readTracingContext(fromObject(FULL)), async () => {
      await Promise.resolve()
      updateRequestContext({ userId: 'verified-user' })
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(getRequestContext().userId).toBe('verified-user')
      expect(tracingHeaders()['x-user-id']).toBe('verified-user')
    })
  })

  it('вне запроса updateRequestContext ничего не делает', () => {
    updateRequestContext({ userId: 'nobody' })
    expect(getRequestContext()).toEqual({})
  })

  it('параллельные запросы не видят контекст друг друга', async () => {
    const seen: string[] = []
    const handle = (traceId: string, delayMs: number) =>
      runWithRequestContext({ rqUId: traceId }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        seen.push(`${traceId}:${getRequestContext().rqUId}`)
      })

    await Promise.all([handle('a', 20), handle('b', 1), handle('c', 10)])
    expect(seen.sort()).toEqual(['a:a', 'b:b', 'c:c'])
  })

  it('слушатель события, привязанный в запросе, помнит его, непривязанный нет', () => {
    const emitter = new EventEmitter()
    const seen: Array<string | undefined> = []

    runWithRequestContext({ rqUId: 'trace-1' }, () => {
      emitter.on(
        'bound',
        bindRequestContext(() => seen.push(getRequestContext().rqUId)),
      )
      emitter.on('plain', () => seen.push(getRequestContext().rqUId))
    })

    // A socket emits from its own context, outside the request that registered the listener.
    runWithRequestContext({ rqUId: 'trace-other' }, () => {
      emitter.emit('bound')
      emitter.emit('plain')
    })
    expect(seen).toEqual(['trace-1', 'trace-other'])
  })
})

describe('логгер', () => {
  it('поля контекста попадают в записи: только заданные', () => {
    expect(requestContextLogFields()).toEqual({})
    const fields = runWithRequestContext({ rqUId: 'trace-1', userId: 'user-1' }, () =>
      requestContextLogFields(),
    )
    expect(fields).toEqual({ rqUId: 'trace-1', userId: 'user-1' })
  })

  it('корневой логгер и его дочерние подмешивают контекст', () => {
    const mixin = (logger: object) => (logger as Record<symbol, unknown>)[symbols.mixinSym]
    const root = getRootLogger()
    expect(mixin(root)).toBe(requestContextLogFields)
    expect(mixin(root.child({}, { level: 'info' }))).toBe(requestContextLogFields)
  })
})
