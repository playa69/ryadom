import { createHmac } from 'node:crypto'

/**
 * The Telegram Mini App without Telegram: the launch the bot's "Открыть" button makes, built by hand. The
 * page gets the same address Telegram opens (`#tgWebAppData=…`), signed with the bot token the e2e API
 * runs with, so the client and the server do exactly what they do inside Telegram.
 */

/** The same value as TELEGRAM_BOT_TOKEN in scripts/stack.mjs. Made up: it belongs to no real bot. */
export const E2E_TELEGRAM_BOT_TOKEN = '100000001:e2e-only-telegram-bot-token-0123456789'

export interface TelegramTestUser {
  id: number
  first_name: string
}

/** A Telegram user id nobody else in this run has: the database is not cleaned between tests. */
export function uniqueTelegramId(): number {
  return 7_000_000_000 + (Date.now() % 1_000_000_000) + Math.floor(Math.random() * 1000)
}

/** Launch data as Telegram signs it (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). */
export function signedInitData(user: TelegramTestUser, authDate = Math.floor(Date.now() / 1000)): string {
  const fields: Record<string, string> = {
    auth_date: String(authDate),
    query_id: `AAE2E${user.id}`,
    user: JSON.stringify({ ...user, language_code: 'ru', allows_write_to_pm: true }),
  }
  const lines = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(E2E_TELEGRAM_BOT_TOKEN).digest()
  const params = new URLSearchParams(fields)
  params.set('hash', createHmac('sha256', secret).update(lines).digest('hex'))
  return params.toString()
}

/** The address Telegram opens the Mini App at: the app's URL with the launch parameters in the hash. */
export function telegramLaunchUrl(appUrl: string, user: TelegramTestUser): string {
  const hash = new URLSearchParams({
    tgWebAppData: signedInitData(user),
    tgWebAppVersion: '8.0',
    tgWebAppPlatform: 'weba',
    tgWebAppThemeParams: JSON.stringify({ bg_color: '#ffffff' }),
  })
  return `${appUrl}/#${hash.toString()}`
}
