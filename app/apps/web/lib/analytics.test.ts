import { describe, expect, it } from 'vitest'
import { ConfirmEmailApiErrorCode } from '@ryadom/contracts/api/auth/confirm-email'
import { RegisterApiErrorCode } from '@ryadom/contracts/api/auth/register'
import { ResetPasswordApiErrorCode } from '@ryadom/contracts/api/auth/reset-password'
import { ApiError, NETWORK_ERROR_STATUS } from '@ryadom/client-core/errors'
import { MicrophoneDeniedError } from '@ryadom/client-core/voice/capture'
import { codeOutcome, formOutcome, isStandalone, micProblemReason } from './analytics'

describe('formOutcome', () => {
  it('a wrong password and other refusals are the server saying no', () => {
    expect(formOutcome(new ApiError(401))).toBe('rejected')
    expect(formOutcome(new ApiError(403))).toBe('rejected')
    expect(formOutcome(new ApiError(409))).toBe('rejected')
  })

  it('a validation answer is a message the person saw', () => {
    expect(formOutcome(new ApiError(422))).toBe('invalid')
    expect(formOutcome(new ApiError(400))).toBe('invalid')
  })

  it('too many requests is a limit, not a refusal', () => {
    expect(formOutcome(new ApiError(429))).toBe('rate_limited')
  })

  it('no connection, a broken server and anything unexpected are errors', () => {
    expect(formOutcome(new ApiError(NETWORK_ERROR_STATUS))).toBe('error')
    expect(formOutcome(new ApiError(500))).toBe('error')
    expect(formOutcome(new ApiError(503))).toBe('error')
    expect(formOutcome(new TypeError('boom'))).toBe('error')
    expect(formOutcome(undefined)).toBe('error')
  })
})

describe('codeOutcome', () => {
  it('"too many attempts" is a limit', () => {
    expect(codeOutcome(ConfirmEmailApiErrorCode.TOO_MANY_ATTEMPTS)).toBe('rate_limited')
    expect(codeOutcome(ResetPasswordApiErrorCode.TOO_MANY_ATTEMPTS)).toBe('rate_limited')
  })

  it('every other named rule is a refusal', () => {
    expect(codeOutcome(ConfirmEmailApiErrorCode.CODE_INVALID)).toBe('rejected')
    expect(codeOutcome(RegisterApiErrorCode.USER_ALREADY_EXISTS)).toBe('rejected')
    expect(codeOutcome('A_CODE_FROM_A_NEWER_SERVER')).toBe('rejected')
  })
})

describe('micProblemReason', () => {
  it('a refused permission is reported as such', () => {
    expect(micProblemReason(new MicrophoneDeniedError(), true)).toBe('permission_denied')
  })

  it('a browser that cannot capture is unsupported whatever the error says', () => {
    expect(micProblemReason(new MicrophoneDeniedError(), false)).toBe('unsupported')
    expect(micProblemReason(new Error('x'), false)).toBe('unsupported')
  })

  it('a failure after the microphone opened is the browser not managing the audio', () => {
    expect(micProblemReason(new DOMException('no worklet', 'AbortError'), true)).toBe('unsupported')
  })
})

describe('isStandalone', () => {
  const win = (matches: boolean, navigator: object = {}) => ({
    matchMedia: (query: string) => ({ matches: matches && query === '(display-mode: standalone)' }),
    navigator,
  })

  it('an installed app is standalone by display mode', () => {
    expect(isStandalone(win(true))).toBe(true)
  })

  it('Safari on the home screen says so with its own flag', () => {
    expect(isStandalone(win(false, { standalone: true }))).toBe(true)
  })

  it('a tab in a browser is not', () => {
    expect(isStandalone(win(false))).toBe(false)
    expect(isStandalone(win(false, { standalone: false }))).toBe(false)
  })

  it('a browser without the media query is not standalone, and does not throw', () => {
    expect(
      isStandalone({
        matchMedia: () => {
          throw new Error('unsupported')
        },
        navigator: {},
      }),
    ).toBe(false)
  })
})
