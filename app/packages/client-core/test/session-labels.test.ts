/**
 * How the list of sessions is worded: the names of devices and the "last seen" line.
 */
import { describe, expect, it } from 'vitest'
import { SessionClient } from '@ryadom/contracts/api/auth/sessions'
import { sessionIsPhone, sessionLastSeen, sessionTitle } from '../src/sessions'

describe('название сессии', () => {
  it.each([
    [{ client: SessionClient.Web, browser: 'Chrome', os: 'Windows' }, 'Chrome · Windows'],
    [{ client: SessionClient.Web, browser: 'Safari', os: null }, 'Safari'],
    [{ client: SessionClient.Web, browser: null, os: 'Linux' }, 'Linux'],
    [{ client: null, browser: 'Firefox', os: 'macOS' }, 'Firefox · macOS'],
    [{ client: SessionClient.Pwa, browser: 'Chrome', os: 'Android' }, 'Приложение · Chrome · Android'],
    [{ client: SessionClient.Pwa, browser: null, os: null }, 'Установленное приложение'],
    // The shell of our own app is named as the app, whatever engine it runs on.
    [{ client: SessionClient.Android, browser: 'Chrome', os: 'Android' }, 'Приложение для Android'],
    [{ client: SessionClient.Ios, browser: 'Safari', os: 'iOS' }, 'Приложение для iPhone'],
    // Inside Telegram the engine is Telegram's webview: the system is all that tells devices apart.
    [
      { client: SessionClient.Telegram, browser: 'Chrome', os: 'Android' },
      'Мини-приложение в Telegram · Android',
    ],
    [{ client: SessionClient.Telegram, browser: null, os: null }, 'Мини-приложение в Telegram'],
    [{ client: null, browser: null, os: null }, 'Неизвестное устройство'],
  ])('%j → «%s»', (session, title) => {
    expect(sessionTitle(session)).toBe(title)
  })
})

describe('телефон или компьютер', () => {
  it.each([
    [{ client: SessionClient.Android, os: null }, true],
    [{ client: SessionClient.Ios, os: null }, true],
    [{ client: SessionClient.Web, os: 'Android' }, true],
    [{ client: SessionClient.Web, os: 'iOS' }, true],
    [{ client: SessionClient.Web, os: 'Windows' }, false],
    [{ client: null, os: null }, false],
  ])('%j → %s', (session, phone) => {
    expect(sessionIsPhone(session)).toBe(phone)
  })
})

describe('когда сессия была активна', () => {
  // Local time on purpose: the words are about the viewer's day, not UTC's.
  const now = new Date(2026, 9, 4, 18, 0)
  const at = (month: number, day: number, hour: number, minute: number, year = 2026) =>
    new Date(year, month - 1, day, hour, minute).toISOString()

  it('сегодня и вчера — словами, остальное датой', () => {
    expect(sessionLastSeen(at(10, 4, 14, 20), now)).toBe('сегодня, 14:20')
    expect(sessionLastSeen(at(10, 3, 9, 5), now)).toBe('вчера, 09:05')
    expect(sessionLastSeen(at(10, 1, 14, 30), now)).toBe('1 октября, 14:30')
  })

  it('«вчера» считается по календарю, а не по 24 часам: 23:50 вчера в 00:10 — уже вчера', () => {
    const justAfterMidnight = new Date(2026, 9, 4, 0, 10)
    expect(sessionLastSeen(at(10, 3, 23, 50), justAfterMidnight)).toBe('вчера, 23:50')
  })

  it('прошлый год называется с годом', () => {
    expect(sessionLastSeen(at(12, 30, 10, 0, 2025), now)).toBe('30 декабря 2025 г., 10:00')
  })

  it('непонятная дата — пустая строка, а не «Invalid Date»', () => {
    expect(sessionLastSeen('не дата', now)).toBe('')
  })
})
