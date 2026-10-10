import { describe, expect, it, vi } from 'vitest'
import { createIngestProxy, routeIngestPath } from '../src/ingest-proxy'

function makeProxy(upstream: (url: URL, init: RequestInit) => Response | Promise<Response>, extra = {}) {
  const calls: { url: URL; init: RequestInit }[] = []
  const fetchStub = vi.fn(async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input))
    calls.push({ url, init })
    return upstream(url, init)
  })
  const proxy = createIngestProxy({
    ingestHost: 'https://eu.i.posthog.com',
    assetsHost: 'https://eu-assets.i.posthog.com',
    basePath: '/api/ingest',
    fetch: fetchStub as unknown as typeof fetch,
    ...extra,
  })
  return { proxy, calls }
}

const ok = () => new Response('{"status":1}', { status: 200, headers: { 'content-type': 'application/json' } })

describe('routeIngestPath', () => {
  it('события и флаги идут на ingest, скрипты на assets', () => {
    expect(routeIngestPath('/e/', 'POST')).toEqual({ target: 'ingest', path: '/e/' })
    expect(routeIngestPath('/i/v0/e/', 'POST')).toEqual({ target: 'ingest', path: '/i/v0/e/' })
    expect(routeIngestPath('/flags/', 'POST')?.target).toBe('ingest')
    expect(routeIngestPath('/s/', 'POST')?.target).toBe('ingest')
    expect(routeIngestPath('/static/recorder.js', 'GET')).toEqual({ target: 'assets', path: '/static/recorder.js' })
    expect(routeIngestPath('/array/phc_x/config.js', 'GET')?.target).toBe('assets')
  })

  it('список опросов (нужен, когда опросы включены) читается, но не пишется', () => {
    expect(routeIngestPath('/api/surveys/', 'GET')).toEqual({ target: 'ingest', path: '/api/surveys/' })
    expect(routeIngestPath('/api/surveys/', 'POST')).toBeNull()
    // The rest of /api/ is PostHog's management API and stays closed.
    expect(routeIngestPath('/api/projects/1/surveys/', 'GET')).toBeNull()
    expect(routeIngestPath('/api/surveysx', 'GET')).toBeNull()
  })

  it('чужое не пропускает', () => {
    expect(routeIngestPath('/api/projects/1', 'GET')).toBeNull()
    expect(routeIngestPath('/', 'GET')).toBeNull()
    expect(routeIngestPath('/event', 'POST')).toBeNull()
    expect(routeIngestPath('/static/../api/x', 'GET')).toBeNull()
  })

  it('на assets пишут только GET и HEAD', () => {
    expect(routeIngestPath('/static/x.js', 'POST')).toBeNull()
  })
})

describe('createIngestProxy', () => {
  it('пересылает событие на ingest-хост и возвращает ответ PostHog', async () => {
    const { proxy, calls } = makeProxy(ok)
    const response = await proxy(
      new Request('https://app.test/api/ingest/e/?compression=gzip-js&ver=1', {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'user-agent': 'UA/1', cookie: 'sid=secret', authorization: 'Bearer x' },
        body: 'payload',
      }),
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 1 })

    const { url, init } = calls[0]!
    expect(url.origin).toBe('https://eu.i.posthog.com')
    expect(url.pathname).toBe('/e/')
    expect(url.searchParams.get('compression')).toBe('gzip-js')
    // The address of the person is not asked to be recorded.
    expect(url.searchParams.get('ip')).toBe('0')

    const headers = new Headers(init.headers)
    expect(headers.get('user-agent')).toBe('UA/1')
    expect(headers.get('content-type')).toBe('text/plain')
    // Credentials of our own app never reach a third party.
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-forwarded-for')).toBeNull()
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('payload')
  })

  it('скрипты берёт с assets-хоста', async () => {
    const { proxy, calls } = makeProxy(() => new Response('/*js*/', { headers: { 'content-type': 'text/javascript' } }))
    const response = await proxy(new Request('https://app.test/api/ingest/static/recorder.js'))
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(await response.text()).toBe('/*js*/')
    expect(calls[0]!.url.href).toBe('https://eu-assets.i.posthog.com/static/recorder.js')
    expect(calls[0]!.url.searchParams.has('ip')).toBe(false)
  })

  it('адрес клиента пересылается только по явному включению', async () => {
    const { proxy, calls } = makeProxy(ok, { forwardClientIp: true, clientIp: () => '203.0.113.7' })
    await proxy(new Request('https://app.test/api/ingest/e/', { method: 'POST', body: 'x' }))
    expect(new Headers(calls[0]!.init.headers).get('x-forwarded-for')).toBe('203.0.113.7')
    expect(calls[0]!.url.searchParams.has('ip')).toBe(false)
  })

  it('неизвестный путь — 404, метод вне списка — 405, и на сеть никто не ходит', async () => {
    const { proxy, calls } = makeProxy(ok)
    expect((await proxy(new Request('https://app.test/api/ingest/api/projects'))).status).toBe(404)
    expect((await proxy(new Request('https://app.test/other/e/', { method: 'POST', body: 'x' }))).status).toBe(404)
    expect((await proxy(new Request('https://app.test/api/ingest/e/', { method: 'DELETE' }))).status).toBe(405)
    expect(calls).toHaveLength(0)
  })

  it('слишком большое тело — 413, до обращения к PostHog', async () => {
    const { proxy, calls } = makeProxy(ok, { maxBodyBytes: 10 })
    const declared = await proxy(
      new Request('https://app.test/api/ingest/e/', { method: 'POST', body: 'x'.repeat(50), headers: { 'content-length': '50' } }),
    )
    expect(declared.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('тело без content-length тоже ограничено при чтении потока', async () => {
    const { proxy, calls } = makeProxy(ok, { maxBodyBytes: 10 })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(6)))
        controller.enqueue(new TextEncoder().encode('x'.repeat(6)))
        controller.close()
      },
    })
    const response = await proxy(
      new Request('https://app.test/api/ingest/e/', { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
    )
    expect(response.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  it('недоступный PostHog — 502, а не исключение', async () => {
    const { proxy } = makeProxy(() => {
      throw new Error('network down')
    })
    const response = await proxy(new Request('https://app.test/api/ingest/e/', { method: 'POST', body: 'x' }))
    expect(response.status).toBe(502)
  })

  it('редирект от PostHog не отдаётся клиенту', async () => {
    const { proxy } = makeProxy(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }))
    const response = await proxy(new Request('https://app.test/api/ingest/e/', { method: 'POST', body: 'x' }))
    expect(response.status).toBe(502)
    expect(response.headers.get('location')).toBeNull()
  })

  it('ошибки PostHog (4xx) проходят как есть', async () => {
    const { proxy } = makeProxy(() => new Response('{"error":"bad"}', { status: 400, headers: { 'content-type': 'application/json' } }))
    const response = await proxy(new Request('https://app.test/api/ingest/e/', { method: 'POST', body: 'x' }))
    expect(response.status).toBe(400)
  })

  it('Content-Encoding и длина ответа не пересылаются: тело уже распаковано', async () => {
    const { proxy } = makeProxy(
      () => new Response('ok', { headers: { 'content-encoding': 'gzip', 'content-length': '999', 'content-type': 'text/plain' } }),
    )
    const response = await proxy(new Request('https://app.test/api/ingest/flags/', { method: 'POST', body: '{}' }))
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('content-length')).not.toBe('999')
  })
})
