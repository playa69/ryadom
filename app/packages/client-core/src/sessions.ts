import { SessionClient, type SessionApiResponse } from '@ryadom/contracts/api/auth/sessions'

/**
 * How a session of the list is named on screen, the same on the phone and in the browser. The server
 * sends the pieces (which of our clients, the names of the browser and the system); the words are
 * chosen here.
 */

type Named = Pick<SessionApiResponse, 'client' | 'browser' | 'os'>

/** "Chrome · Windows", "Приложение для Android"; a device that said nothing is just that. */
export function sessionTitle({ client, browser, os }: Named): string {
  // Our own apps are named for what they are: the engine inside a shell is not what the person sees.
  if (client === SessionClient.Android) return 'Приложение для Android'
  if (client === SessionClient.Ios) return 'Приложение для iPhone'
  if (client === SessionClient.Telegram)
    return os ? `Мини-приложение в Telegram · ${os}` : 'Мини-приложение в Telegram'
  const where = [browser, os].filter(Boolean).join(' · ')
  if (client === SessionClient.Pwa) return where ? `Приложение · ${where}` : 'Установленное приложение'
  return where || 'Неизвестное устройство'
}

/** Whether to draw a phone or a computer. A browser on a phone system is a phone too. */
export function sessionIsPhone({ client, os }: Pick<SessionApiResponse, 'client' | 'os'>): boolean {
  return client === SessionClient.Android || client === SessionClient.Ios || os === 'Android' || os === 'iOS'
}

const DAY_FORMAT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' })
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
const TIME_FORMAT = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * When the session was last seen, to the day: "сегодня, 14:20", "вчера, 09:05", "1 октября, 14:30".
 * The server only knows the last refresh, which trails the person's real last request by up to 15
 * minutes, so nothing finer than a clock time is claimed. An unreadable date gives an empty string.
 * `now` is a parameter so the words are testable.
 */
export function sessionLastSeen(iso: string, now: Date = new Date()): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const time = TIME_FORMAT.format(date)
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)
  if (days === 0) return `сегодня, ${time}`
  if (days === 1) return `вчера, ${time}`
  const day =
    date.getFullYear() === now.getFullYear() ? DAY_FORMAT.format(date) : DAY_YEAR_FORMAT.format(date)
  return `${day}, ${time}`
}
