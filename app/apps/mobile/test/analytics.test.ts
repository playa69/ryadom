/**
 * The mappings between what the screens know and the values of the analytics catalog. The SDK itself
 * is replaced by a spy: what matters here is what the app asks to report, and how often.
 */
import { ApiError, NETWORK_ERROR_STATUS } from '@ryadom/client-core/errors'
import { MicrophoneDeniedError, MicrophoneError } from '@ryadom/client-core/voice/capture'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('@ryadom/analytics/browser', () => ({ track: sdk.track }))

import {
  analyticsPlatform,
  metrikaPageBase,
  micFailureReason,
  micProblem,
  outcomeFromCode,
  outcomeFromError,
  reportAppUpdate,
  reportVoiceProblem,
  screenPath,
} from '../src/client/lib/analytics'

beforeEach(() => {
  sdk.track.mockClear()
})

describe('адрес экранов для Яндекс Метрики', () => {
  const site = 'https://xn--site.test'

  it('PWA и Telegram — под префиксом, на котором опубликована PWA: по нему кабинет узнаёт продукт', () => {
    for (const platform of ['pwa', 'telegram', 'web'] as const) {
      expect(metrikaPageBase({ platform, apiBase: '', origin: site, baseUrl: '/pwa/' })).toBe(`${site}/pwa`)
    }
  })

  it('PWA на корне хоста (разработка) — без префикса и без косой черты в конце', () => {
    expect(
      metrikaPageBase({ platform: 'pwa', apiBase: '', origin: 'http://localhost:5174', baseUrl: '/' }),
    ).toBe('http://localhost:5174')
  })

  it('сборки магазинов — под адресом сайта (а не localhost WebView) и своим префиксом', () => {
    expect(
      metrikaPageBase({ platform: 'android', apiBase: site, origin: 'https://localhost', baseUrl: '/' }),
    ).toBe(`${site}/android`)
    expect(
      metrikaPageBase({
        platform: 'ios',
        apiBase: `${site}/`,
        origin: 'capacitor://localhost',
        baseUrl: '/',
      }),
    ).toBe(`${site}/ios`)
  })

  it('если адрес API неизвестен, берётся собственный адрес страницы', () => {
    expect(
      metrikaPageBase({ platform: 'android', apiBase: '', origin: 'https://localhost', baseUrl: '/' }),
    ).toBe('https://localhost/android')
  })
})

describe('платформа аналитики', () => {
  it('оболочка магазина важнее режима окна', () => {
    expect(analyticsPlatform({ android: true, ios: false, standalone: true })).toBe('android')
    expect(analyticsPlatform({ android: false, ios: true, standalone: false })).toBe('ios')
  })

  it('веб-сборка: установленное приложение это pwa, вкладка это web', () => {
    expect(analyticsPlatform({ android: false, ios: false, standalone: true })).toBe('pwa')
    expect(analyticsPlatform({ android: false, ios: false, standalone: false })).toBe('web')
  })

  it('веб-сборка, открытая как Mini App в Telegram, это telegram', () => {
    expect(analyticsPlatform({ android: false, ios: false, standalone: false, telegram: true })).toBe(
      'telegram',
    )
    expect(analyticsPlatform({ android: false, ios: false, standalone: true, telegram: true })).toBe(
      'telegram',
    )
  })
})

describe('исход формы по ошибке (общее отображение статусов, как в вебе)', () => {
  it('429 это лимит, 422 это проверка сервера, остальные 4xx это отказ', () => {
    expect(outcomeFromError(new ApiError(429))).toBe('rate_limited')
    expect(outcomeFromError(new ApiError(422))).toBe('invalid')
    expect(outcomeFromError(new ApiError(401))).toBe('rejected')
    expect(outcomeFromError(new ApiError(409, 'TAKEN'))).toBe('rejected')
  })

  it('400 это наш баг, а не ошибка человека: на всех платформах одинаково', () => {
    expect(outcomeFromError(new ApiError(400))).toBe('error')
  })

  it('нет связи, 5xx и чужие ошибки это error', () => {
    expect(outcomeFromError(new ApiError(NETWORK_ERROR_STATUS))).toBe('error')
    expect(outcomeFromError(new ApiError(503))).toBe('error')
    expect(outcomeFromError(new Error('boom'))).toBe('error')
    expect(outcomeFromError(undefined)).toBe('error')
  })
})

describe('исход формы по коду сервера', () => {
  it('слишком много попыток это лимит, остальное отказ', () => {
    expect(outcomeFromCode('TOO_MANY_ATTEMPTS')).toBe('rate_limited')
    expect(outcomeFromCode('CODE_INVALID')).toBe('rejected')
    expect(outcomeFromCode('EMAIL_TAKEN')).toBe('rejected')
  })
})

describe('название экрана', () => {
  it('параметры маршрута называются :id', () => {
    expect(screenPath('/journal/:dialogId/')).toBe('/journal/:id/')
    expect(screenPath('/dialog/:dialogId/')).toBe('/dialog/:id/')
  })

  it('маршрут без параметров не меняется, пустой это ничего', () => {
    expect(screenPath('/profile/change-password/')).toBe('/profile/change-password/')
    expect(screenPath(undefined)).toBeNull()
    expect(screenPath('')).toBeNull()
  })
})

describe('почему не заработал микрофон', () => {
  it('отказ это запрет, с причиной', () => {
    expect(micProblem(new MicrophoneDeniedError())).toEqual({ reason: 'permission_denied', detail: 'not_allowed' })
    expect(micProblem(new MicrophoneDeniedError('blocked'))).toEqual({ reason: 'permission_denied', detail: 'blocked' })
  })

  it('нет устройства это нет микрофона', () => {
    expect(micProblem(new MicrophoneError('not_found'))).toEqual({ reason: 'no_microphone', detail: 'not_found' })
    expect(micFailureReason(new MicrophoneError('not_found'))).toBe('no_microphone')
  })

  it('занят или небезопасный адрес это неподдерживаемое окружение, с причиной', () => {
    expect(micProblem(new MicrophoneError('not_readable'))).toEqual({ reason: 'unsupported', detail: 'not_readable' })
    expect(micProblem(new MicrophoneError('security'))).toEqual({ reason: 'unsupported', detail: 'security' })
  })

  it('любая другая ошибка запуска это неподдерживаемое окружение', () => {
    expect(micFailureReason(new Error('worklet'))).toBe('unsupported')
  })

  it('одна и та же причина за загрузку страницы уходит один раз, другая причина отдельно', () => {
    reportVoiceProblem('permission_denied', 'not_allowed')
    reportVoiceProblem('permission_denied', 'not_allowed')
    reportVoiceProblem('permission_denied', 'blocked')
    expect(sdk.track).toHaveBeenCalledTimes(2)
  })
})
