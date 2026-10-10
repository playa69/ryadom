/**
 * The mappings between what the screens know and the values of the analytics catalog. The SDK itself
 * is replaced by a spy: what matters here is what the app asks to report, and how often.
 */
import { ApiError, NETWORK_ERROR_STATUS } from '@ryadom/client-core/errors'
import { MicrophoneDeniedError } from '@ryadom/client-core/voice/capture'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({ track: vi.fn() }))
vi.mock('@ryadom/analytics/browser', () => ({ track: sdk.track }))

import {
  accountKind,
  analyticsPlatform,
  micFailureReason,
  outcomeFromCode,
  outcomeFromError,
  reportAppUpdate,
  reportVoiceProblem,
  screenPath,
} from '../src/client/lib/analytics'

beforeEach(() => {
  sdk.track.mockClear()
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
})

describe('вид аккаунта', () => {
  it('без почты аккаунт анонимный, с почтой обычный', () => {
    expect(accountKind({ email: null })).toBe('anonymous')
    expect(accountKind({ email: 'a@example.com' })).toBe('email')
  })
})

describe('исход формы по ошибке', () => {
  it('429 это лимит, 422 это проверка сервера, остальные 4xx это отказ', () => {
    expect(outcomeFromError(new ApiError(429))).toBe('rate_limited')
    expect(outcomeFromError(new ApiError(422))).toBe('invalid')
    expect(outcomeFromError(new ApiError(401))).toBe('rejected')
    expect(outcomeFromError(new ApiError(409, 'TAKEN'))).toBe('rejected')
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
  it('отказ без устройств в списке это нет микрофона', () => {
    expect(micFailureReason(new MicrophoneDeniedError(), 0)).toBe('no_microphone')
  })

  it('отказ при микрофоне в списке или без списка это запрет', () => {
    expect(micFailureReason(new MicrophoneDeniedError(), 1)).toBe('permission_denied')
    expect(micFailureReason(new MicrophoneDeniedError(), null)).toBe('permission_denied')
  })

  it('любая другая ошибка запуска это неподдерживаемое окружение', () => {
    expect(micFailureReason(new Error('worklet'), 1)).toBe('unsupported')
    expect(micFailureReason(new Error('worklet'), 0)).toBe('unsupported')
  })
})

describe('частота отчётов', () => {
  it('проблема голоса уходит один раз на причину', () => {
    reportVoiceProblem('playback_failed')
    reportVoiceProblem('playback_failed')
    reportVoiceProblem('unsupported')

    expect(sdk.track).toHaveBeenCalledTimes(2)
    expect(sdk.track).toHaveBeenCalledWith('voice_problem', { reason: 'playback_failed' })
    expect(sdk.track).toHaveBeenCalledWith('voice_problem', { reason: 'unsupported' })
  })

  it('обновление уходит один раз на вид, действие и версию, а версия в отчёт не попадает', () => {
    reportAppUpdate('store', 'available', 42)
    reportAppUpdate('store', 'available', 42)
    reportAppUpdate('store', 'available', 43)

    expect(sdk.track).toHaveBeenCalledTimes(2)
    expect(sdk.track).toHaveBeenCalledWith('app_update', { kind: 'store', action: 'available' })
  })
})
