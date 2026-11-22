import { describe, expect, it, vi } from 'vitest'
import { createMicrophoneRecovery, microphonePermissionSteps } from '../src/voice/microphone-permission'

// OpenSpec dialog-voice, «Микрофон или голос недоступны» (REQ-VOICE-01, PROTEUS-317).
describe('microphonePermissionSteps', () => {
  it.each([
    ['Windows Chrome/146.0 Safari/537.36', 0, false, 'Сведения о сайте'],
    ['Android Chrome/146.0 Safari/537.36', 5, false, 'Разрешения'],
    ['iPhone CriOS/146.0 Safari/604.1', 5, false, 'значок микрофона'],
    ['iPhone Version/26.0 Safari/604.1', 5, false, 'меню страницы'],
    ['Macintosh Version/26.0 Safari/604.1', 5, false, 'меню страницы'],
    ['Macintosh Version/26.0 Safari/604.1', 0, false, 'Веб-сайты'],
    ['Windows Firefox/146.0', 0, false, 'значок разрешений'],
    ['Windows Chrome/146.0 Safari/537.36 Edg/146.0', 0, false, 'Сведения о сайте'],
    ['Linux Chrome/146.0 Safari/537.36', 0, true, 'окна «Рядом»'],
    ['Android Chrome/146.0 Safari/537.36', 5, true, 'Настройки сайтов'],
    ['Android; wv) Chrome/146.0 Safari/537.36', 5, false, 'настройках браузера или приложения'],
    ['iPhone Version/26.0 Safari/604.1', 5, true, 'настройках браузера или приложения'],
    ['Unknown', 0, false, 'настройках браузера или приложения'],
  ])(
    'выбирает инструкцию для %s (касания: %i, установлено: %s)',
    (userAgent, maxTouchPoints, standalone, text) => {
      expect(microphonePermissionSteps({ userAgent, maxTouchPoints, standalone })[0]).toContain(text)
    },
  )
})

describe('createMicrophoneRecovery', () => {
  it('считает первый отказ и первое успешное открытие после него', () => {
    const report = vi.fn()
    const recovery = createMicrophoneRecovery(report)
    recovery.denied(0)
    recovery.denied(120)
    recovery.opened(340)
    recovery.opened(420)
    recovery.denied(460)
    expect(report.mock.calls).toEqual([[{ stage: 'denied' }], [{ stage: 'recovered', elapsed_ms: 340 }]])
  })

  it('измеряет восстановление после исходного отказа, если микрофон ещё не открывался', () => {
    const report = vi.fn()
    const recovery = createMicrophoneRecovery(report)
    recovery.opened(0)
    recovery.denied(120)
    recovery.opened(340)
    expect(report).not.toHaveBeenCalled()
  })
})
