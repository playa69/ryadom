/**
 * Transport: the envelope, statuses, JWT, the version gate, CORS and rate limits.
 */
import { resetDraining, startDraining } from '../src/lib/lifecycle'
import { SignJWT, decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'
import { MeApiErrorCode } from '@ryadom/contracts/api/auth/me'
import { AppHeader, AppPlatform } from '@ryadom/contracts/api/headers'
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, createJwt } from '../src/lib/jwt'
import { createRateLimiter } from '../src/lib/rate-limit'
import {
  EMPTY_POLICY,
  compareVersions,
  isVersionString,
  resolveAppStatus,
  type ReleasePolicy,
} from '../src/lib/release-policy'
import { UpdateAvailability } from '@ryadom/contracts/api/app-status'
import { call, expectTransportError, makeApp, ok, uniqueEmail } from './helpers'

const SECRET = process.env.MOBILE_JWT_SECRET ?? ''
const jwt = createJwt(SECRET)
const otherJwt = createJwt('another-secret-another-secret-0123456789')

const POLICY: ReleasePolicy = {
  android: { minVersionCode: 10, latestVersionCode: 12, downloadUrl: 'https://downloads.test/ryadom.apk' },
  ios: { minVersionCode: 5, latestVersionCode: 7, downloadUrl: null },
  js: {
    latestVersion: '1.2.0',
    minVersion: null,
    bundleUrl: 'http://localhost:3002/api/ota/ryadom-prod-1.2.0.zip',
    checksum: 'a'.repeat(64),
  },
}

const { app } = makeApp({ policy: POLICY })

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

describe('health и политика версий', () => {
  it('GET /api/health — с проверкой БД, без конверта и без гейта версий', async () => {
    const response = await app.request('/api/health', {
      headers: { [AppHeader.Platform]: AppPlatform.Android, [AppHeader.AppVersion]: '1' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok' })
  })

  it('пока под останавливают, проба отвечает 503: балансировщик успевает его убрать', async () => {
    startDraining()
    try {
      const response = await app.request('/api/health')
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ status: 'draining' })
    } finally {
      resetDraining()
    }
  })

  it('app-status отвечает по платформе клиента', async () => {
    const android = ok<Record<string, unknown>>(
      await call(app, 'GET', '/api/app-status?platform=android&version_code=12&js_version=1.2.0'),
    )
    expect(android).toMatchObject({
      runtimeUpdate: UpdateAvailability.NotAvailable,
      latestVersionCode: 12,
      downloadUrl: 'https://downloads.test/ryadom.apk',
      storeUrl: 'https://apps.rustore.ru/app/ru.ryadom.app',
      jsUpdate: UpdateAvailability.NotAvailable,
    })

    const ios = ok<Record<string, unknown>>(
      await call(app, 'GET', '/api/app-status?platform=ios&version_code=6'),
    )
    // iOS has its own build numbers and no APK link.
    expect(ios).toMatchObject({
      runtimeUpdate: UpdateAvailability.Available,
      latestVersionCode: 7,
      downloadUrl: null,
    })
  })

  it('непригодные параметры app-status — 400', async () => {
    await expectTransportError(await app.request('/api/app-status?platform=web&version_code=5'), 400)
    await expectTransportError(await app.request('/api/app-status?platform=android&version_code=abc'), 400)
    await expectTransportError(await app.request('/api/app-status'), 400)
  })

  it('версия ниже минимальной — 426 на всё остальное, с заголовками CORS', async () => {
    const response = await app.request('/api/auth/me', {
      headers: {
        [AppHeader.Platform]: AppPlatform.Android,
        [AppHeader.AppVersion]: '9',
        Origin: 'https://localhost',
      },
    })
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    await expectTransportError(response, 426)
  })

  it('веб-сборка без заголовков платформы гейт не проверяет', async () => {
    await expectTransportError(await app.request('/api/auth/me'), 401)
  })

  it('GET /api/ota/:file — 404 без бандла в образе, гейт версий его не трогает', async () => {
    // No manifest exists in the test process (APP_ENV=local never has one, see ota-bundle.ts), so
    // this is a plain 404 rather than the bundle contents; the point is that a version below the
    // minimum still reaches the route instead of getting a 426 that would trap it.
    const response = await app.request('/api/ota/ryadom-prod-1.2.0.zip', {
      headers: { [AppHeader.Platform]: AppPlatform.Android, [AppHeader.AppVersion]: '9' },
    })
    await expectTransportError(response, 404)
  })

  it('матрица обновлений: две оси и откат бандла', () => {
    const status = (platform: AppPlatform, versionCode: number, jsVersion: string | null) =>
      resolveAppStatus(POLICY, { platform, versionCode, jsVersion }, null)

    expect(status(AppPlatform.Android, 12, '1.1.5')).toMatchObject({
      jsUpdate: UpdateAvailability.Available,
      jsBundleUrl: POLICY.js.bundleUrl,
    })
    // A client newer than the server means a broken bundle is being rolled back: apply at once.
    // (A redeployed prior image is the kill switch here - see release-policy.ts.)
    expect(status(AppPlatform.Android, 12, '1.3.0')).toMatchObject({ jsUpdate: UpdateAvailability.Required })
    // A client without OTA: the JS axis does not exist for it.
    expect(status(AppPlatform.Android, 12, null)).toMatchObject({ jsUpdate: UpdateAvailability.NotAvailable })
    // Below the native minimum: 426 territory regardless of the JS axis.
    expect(status(AppPlatform.Android, 9, '1.0.0')).toMatchObject({
      runtimeUpdate: UpdateAvailability.Required,
    })
    expect(status(AppPlatform.Android, 12, '1.2.0')).toMatchObject({
      jsUpdate: UpdateAvailability.NotAvailable,
      jsBundleUrl: null,
      jsBundleChecksum: null,
    })
  })

  // `openspec/changes/add-required-js-update`, «Решение сервера по версии JS».
  it('минимум JS: ниже него пакет применяется сразу, выше — тихо', () => {
    const withMin = (minVersion: string) => ({ ...POLICY, js: { ...POLICY.js, minVersion } })
    const status = (policy: ReleasePolicy, jsVersion: string) =>
      resolveAppStatus(policy, { platform: AppPlatform.Android, versionCode: 12, jsVersion }, null)

    expect(status(withMin('1.2.0'), '1.1.5')).toMatchObject({
      jsUpdate: UpdateAvailability.Required,
      jsBundleUrl: POLICY.js.bundleUrl,
      jsBundleChecksum: POLICY.js.checksum,
    })
    expect(status(withMin('1.1.0'), '1.1.5')).toMatchObject({ jsUpdate: UpdateAvailability.Available })
    expect(status(withMin('1.1.5'), '1.1.5')).toMatchObject({ jsUpdate: UpdateAvailability.Available })
    // A minimum above the bundle cannot be met: whoever runs the bundle is left alone.
    expect(status(withMin('2.0.0'), '1.1.5')).toMatchObject({ jsUpdate: UpdateAvailability.Required })
    expect(status(withMin('2.0.0'), '1.2.0')).toMatchObject({ jsUpdate: UpdateAvailability.NotAvailable })
    // Clients already in the field report the bare package version, which is below every bundle.
    expect(status(withMin('0.1.0.42'), '0.1.0')).toMatchObject({ jsUpdate: UpdateAvailability.Required })
  })

  it('минимум JS без пакета или для слишком старого натива ничего не требует', () => {
    const noBundle: ReleasePolicy = { ...POLICY, js: { ...EMPTY_POLICY.js, minVersion: '1.2.0' } }
    expect(
      resolveAppStatus(
        noBundle,
        { platform: AppPlatform.Android, versionCode: 12, jsVersion: '1.0.0' },
        null,
      ),
    ).toMatchObject({ jsUpdate: UpdateAvailability.NotAvailable, jsBundleUrl: null })
    expect(
      resolveAppStatus(
        { ...POLICY, js: { ...POLICY.js, minVersion: '1.2.0' } },
        { platform: AppPlatform.Android, versionCode: 10, jsVersion: '1.0.0' },
        null,
        { [AppPlatform.Android]: 11 },
      ),
    ).toMatchObject({ jsUpdate: UpdateAvailability.NotAvailable, jsBundleUrl: null })
  })

  it('устаревший JS ниже минимума не получает 426', async () => {
    const { app: strictApp } = makeApp({ policy: { ...POLICY, js: { ...POLICY.js, minVersion: '1.2.0' } } })
    await expectTransportError(
      await strictApp.request('/api/auth/me', {
        headers: {
          [AppHeader.Platform]: AppPlatform.Android,
          [AppHeader.AppVersion]: '12',
          [AppHeader.JsVersion]: '1.0.0',
        },
      }),
      401,
    )
  })

  it('минимальная поддерживаемая сборка натива для бандла: свежий JS не предлагается слишком старому нативу', () => {
    // OTA_MIN_NATIVE_BUILD in release-policy.ts is bumped by hand only when a bundle needs a new
    // native capability; passing a map here exercises the branch without waiting for that to happen.
    const status = resolveAppStatus(
      POLICY,
      { platform: AppPlatform.Android, versionCode: 10, jsVersion: '1.0.0' },
      null,
      {
        [AppPlatform.Android]: 11,
      },
    )
    expect(status).toMatchObject({ jsUpdate: UpdateAvailability.NotAvailable, jsBundleUrl: null })
  })

  it('версии сравниваются числами, мусор — не версия', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1)
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(isVersionString('1.2.3')).toBe(true)
    for (const bad of ['', 'latest', '1.2.3 ', '1.2.3-dev', '1..2']) expect(isVersionString(bad)).toBe(false)
  })

  it('без манифеста политика пустая: обновлений нет, гейт никого не режет', async () => {
    const { app: openApp } = makeApp()
    const status = ok<Record<string, unknown>>(
      await call(openApp, 'GET', '/api/app-status?platform=android&version_code=1'),
    )
    expect(status).toMatchObject({
      runtimeUpdate: UpdateAvailability.NotAvailable,
      jsUpdate: UpdateAvailability.NotAvailable,
    })
    await expectTransportError(
      await openApp.request('/api/auth/me', {
        headers: { [AppHeader.Platform]: AppPlatform.Android, [AppHeader.AppVersion]: '1' },
      }),
      401,
    )
  })
})

describe('JWT', () => {
  it('пара токенов: access на 15 минут, refresh на 30 дней, expiresAt в миллисекундах', async () => {
    const before = Date.now()
    const pair = await jwt.issueTokenPair('user-1')
    const access = decodeJwt(pair.accessToken)
    const refresh = decodeJwt(pair.refreshToken)
    expect(access).toMatchObject({ sub: 'user-1', type: 'access' })
    expect(refresh).toMatchObject({ sub: 'user-1', type: 'refresh' })
    // A refresh token is named (jti) and both tokens say which session they belong to (sid).
    expect(refresh.jti).toMatch(/^[0-9a-f-]{36}$/)
    expect(access.jti).toBeUndefined()
    expect(access.sid).toBe(refresh.sid)
    expect(access.exp! - access.iat!).toBe(ACCESS_TTL_SECONDS)
    expect(refresh.exp! - refresh.iat!).toBe(REFRESH_TTL_SECONDS)
    expect(pair.expiresAt).toBeGreaterThanOrEqual(before + ACCESS_TTL_SECONDS * 1000)
  })

  it('verifyToken проверяет тип, подпись и срок', async () => {
    const pair = await jwt.issueTokenPair('user-1')
    expect(await jwt.verifyToken(pair.accessToken, 'access')).toEqual({
      sub: 'user-1',
      type: 'access',
      sid: decodeJwt(pair.accessToken).sid,
    })
    expect(await jwt.verifyToken(pair.refreshToken, 'access')).toBeNull()
    expect(await jwt.verifyToken((await otherJwt.issueTokenPair('u')).accessToken, 'access')).toBeNull()
    const expired = await new SignJWT({ type: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET))
    expect(await jwt.verifyToken(expired, 'access')).toBeNull()
  })
})

describe('проверка access-токена — только подпись', () => {
  it('без токена — 401; годный токен пропускается к роуту', async () => {
    await expectTransportError(await app.request('/api/auth/me'), 401)

    const { accessToken } = await jwt.issueTokenPair('00000000-0000-4000-8000-000000000000')
    const response = await app.request('/api/auth/me', { headers: bearer(accessToken) })
    // The token was verified without a database query; a missing user is a route rule, not a 401.
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: false, errorCode: MeApiErrorCode.USER_NOT_FOUND })
  })

  it('refresh вместо access и чужая подпись — 401', async () => {
    const { refreshToken } = await jwt.issueTokenPair('user-1')
    const { accessToken: foreign } = await otherJwt.issueTokenPair('user-1')
    for (const token of [refreshToken, foreign]) {
      await expectTransportError(await app.request('/api/auth/me', { headers: bearer(token) }), 401)
    }
  })
})

describe('правила ввода: 400 — запрос не понят, 422 — правило для человека', () => {
  it('битый JSON и отсутствующие поля — 400', async () => {
    await expectTransportError(
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{bad',
      }),
      400,
    )
    await expectTransportError(
      await app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'a@b.c' }),
      }),
      400,
    )
  })

  it('непригодная почта, короткий пароль и код не из шести цифр — 422', async () => {
    const { app: fresh } = makeApp()
    expect(
      (await call(fresh, 'POST', '/api/auth/register', { email: 'nope', password: '12345678', name: 'Аня' }))
        .status,
    ).toBe(422)
    expect(
      (
        await call(fresh, 'POST', '/api/auth/register', {
          email: uniqueEmail(),
          password: '123',
          name: 'Аня',
        })
      ).status,
    ).toBe(422)
    expect(
      (await call(fresh, 'POST', '/api/auth/confirm-email', { email: uniqueEmail(), code: '12' })).status,
    ).toBe(422)
  })

  it('неизвестный роут — 404 в конверте транспорта', async () => {
    for (const path of ['/api/nope', '/api/auth/oauth/start', '/api/notifications']) {
      await expectTransportError(await app.request(path), 404)
    }
  })
})

describe('лимиты частоты', () => {
  it('код на почту — не чаще трёх раз в окно; дальше 429', async () => {
    const { app: fresh } = makeApp()
    const email = uniqueEmail()
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await call(fresh, 'POST', '/api/auth/forgot-password', { email })).status).toBe(200)
    }
    await expectTransportError(
      await fresh.request('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      }),
      429,
    )
  })

  it('лимит считает окно, а не общее число', async () => {
    let now = 0
    const limiter = createRateLimiter(() => now)
    const rule = { limit: 2, windowMs: 1000 }
    expect(await limiter.hit('k', rule)).toBe(true)
    expect(await limiter.hit('k', rule)).toBe(true)
    expect(await limiter.hit('k', rule)).toBe(false)
    now += 1001
    expect(await limiter.hit('k', rule)).toBe(true)
  })
})
