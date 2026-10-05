/**
 * Serving the PWA from the API process: at the root of the host, or under a URL prefix
 * (`PWA_BASE_PATH=/app`) when the host is shared with the landing page and other apps.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeApp } from './helpers'

// What a Vite build leaves in dist/pwa: the entry, the worker, the manifest, hashed assets. Made at
// module level, not in beforeAll: the apps below are built while the tests are being collected.
const root = mkdtempSync(join(tmpdir(), 'ryadom-pwa-'))
mkdirSync(join(root, 'assets'))
writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>PWA</title></head><body></body></html>')
writeFileSync(join(root, 'sw.js'), '// service worker')
writeFileSync(join(root, 'manifest.webmanifest'), '{"name":"Рядом"}')
writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log(1)')

afterAll(() => rmSync(root, { recursive: true, force: true }))

const get = (app: ReturnType<typeof makeApp>['app'], path: string) => app.request(path, { method: 'GET' })

describe('PWA в корне хоста (без префикса)', () => {
  const { app } = makeApp({ pwaRoot: root })

  it('отдаёт вход с подставленными meta, файлы с нужным кэшем, SPA-маршрут как вход', async () => {
    const entry = await get(app, '/')
    expect(entry.status).toBe(200)
    const html = await entry.text()
    expect(html).toContain('name="ryadom-web-url"')
    expect(html).toContain('name="ryadom-app-env"')
    expect(entry.headers.get('cache-control')).toBe('no-cache')

    expect((await get(app, '/manifest.webmanifest')).headers.get('cache-control')).toBe('no-cache')
    const asset = await get(app, '/assets/app-abc123.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')

    expect(await (await get(app, '/dialog/d-1/')).text()).toContain('name="ryadom-web-url"')
  })

  it('неизвестный /api/* — JSON 404, а не HTML', async () => {
    const res = await get(app, '/api/no-such-route')
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toContain('application/json')
  })
})

describe('PWA под префиксом /app', () => {
  const { app } = makeApp({ pwaRoot: root, env: { PWA_BASE_PATH: '/app' } })

  it('вход и файлы отдаются только под префиксом, путь на диске — без него', async () => {
    const entry = await get(app, '/app/')
    expect(entry.status).toBe(200)
    expect(await entry.text()).toContain('name="ryadom-web-url"')

    const asset = await get(app, '/app/assets/app-abc123.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(await asset.text()).toBe('console.log(1)')

    const worker = await get(app, '/app/sw.js')
    expect(worker.status).toBe(200)
    expect(worker.headers.get('cache-control')).toBe('no-cache')
    expect((await get(app, '/app/manifest.webmanifest')).status).toBe(200)
  })

  it('SPA-маршрут под префиксом отдаёт вход', async () => {
    const res = await get(app, '/app/dialog/d-1/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>PWA</title>')
  })

  it('/app ведёт на /app/, корень хоста — на приложение, строка запроса сохраняется', async () => {
    const bare = await get(app, '/app?x=1')
    expect(bare.status).toBe(301)
    expect(bare.headers.get('location')).toBe('/app/?x=1')

    const rootRedirect = await get(app, '/')
    expect(rootRedirect.status).toBe(302)
    expect(rootRedirect.headers.get('location')).toBe('/app/')
  })

  it('вне префикса ничего из PWA не отдаётся: ни файлы, ни SPA-заглушка', async () => {
    for (const path of ['/assets/app-abc123.js', '/sw.js', '/dialog/d-1/', '/index.html']) {
      const res = await get(app, path)
      expect(res.status, path).toBe(404)
      expect(res.headers.get('content-type'), path).toContain('application/json')
    }
    // Похожий по началу путь — другой путь, не часть префикса.
    expect((await get(app, '/application/')).status).toBe(404)
  })

  it('API работает как раньше: /api/health под корнем, а не под префиксом', async () => {
    expect((await get(app, '/api/health')).status).not.toBe(404)
    expect((await get(app, '/app/api/health')).status).toBe(200) // SPA-заглушка под префиксом, не API
  })
})

describe('настройка PWA_BASE_PATH и PUBLIC_APP_URL', () => {
  it('префикс нормализуется: хвостовой слэш убирается, пустое значение — без префикса', async () => {
    const { parseEnv } = await import('../src/lib/env')
    expect(parseEnv({ ...process.env, PWA_BASE_PATH: '/app/' }).PWA_BASE_PATH).toBe('/app')
    expect(parseEnv({ ...process.env, PWA_BASE_PATH: '' }).PWA_BASE_PATH).toBe('')
    expect(parseEnv({ ...process.env, PWA_BASE_PATH: undefined }).PWA_BASE_PATH).toBe('')
    expect(() => parseEnv({ ...process.env, PWA_BASE_PATH: 'app' })).toThrow(/PWA_BASE_PATH/)
    expect(() => parseEnv({ ...process.env, PWA_BASE_PATH: '/a b' })).toThrow(/PWA_BASE_PATH/)
  })

  it('PUBLIC_APP_URL — только origin: путь в нём удвоился бы в адресах OTA-бандлов', async () => {
    const { parseEnv } = await import('../src/lib/env')
    expect(parseEnv({ ...process.env, PUBLIC_APP_URL: 'https://example.com/' }).PUBLIC_APP_URL).toBe('https://example.com')
    expect(() => parseEnv({ ...process.env, PUBLIC_APP_URL: 'https://example.com/app' })).toThrow(/PUBLIC_APP_URL/)
  })
})
