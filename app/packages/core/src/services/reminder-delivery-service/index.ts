import webpush from 'web-push'
import { getEnv } from '../../config'

/**
 * The two server-side channels of the mood reminder (`REQ-WELL-02`): Web Push (VAPID) to a browser or
 * installed PWA, and a Telegram bot message with a button that opens the Mini App on the diary.
 * Both answer with a plain outcome; `gone` tells the scheduler the address is dead and the
 * subscription must be deleted (push service `404`/`410`, bot blocked or chat not found).
 *
 * Tests replace the transport (`setReminderTransport`), so nothing leaves the process.
 */

export type DeliveryOutcome = { ok: true } | { ok: false; gone: boolean; error: string }

export interface WebPushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

/** What the service worker receives; it shows `title`/`body` and opens `url` on a tap. */
export interface WebPushPayload {
  title: string
  body: string
  url: string
  deliveryId: number
}

export interface ReminderTransport {
  sendWebPush(target: WebPushTarget, payload: WebPushPayload): Promise<DeliveryOutcome>
  sendTelegram(chatId: number, text: string, buttonLabel: string): Promise<DeliveryOutcome>
}

/** The public VAPID key a browser subscribes with; null when Web Push is not set up. */
export function vapidPublicKey(): string | null {
  const env = getEnv()
  return env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? env.VAPID_PUBLIC_KEY : null
}

const realTransport: ReminderTransport = {
  async sendWebPush(target, payload) {
    const env = getEnv()
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { ok: false, gone: false, error: 'vapid_not_configured' }
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: {
            subject: env.VAPID_SUBJECT ?? 'mailto:noreply@ryadom.local',
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
          },
          TTL: 2 * 60 * 60,
          urgency: 'normal',
        },
      )
      return { ok: true }
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      return { ok: false, gone: status === 404 || status === 410, error: status ? `push_${status}` : 'push_failed' }
    }
  },

  async sendTelegram(chatId, text, buttonLabel) {
    const env = getEnv()
    if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, gone: false, error: 'bot_not_configured' }
    const url = env.TELEGRAM_MINI_APP_URL
    const button = url
      ? { text: buttonLabel, url }
      : { text: buttonLabel, web_app: { url: `${env.PUBLIC_APP_URL}/pwa/diary/?from=reminder` } }
    try {
      const response = await fetch(`${env.TELEGRAM_API_URL}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, reply_markup: { inline_keyboard: [[button]] } }),
        signal: AbortSignal.timeout(10_000),
      })
      if (response.ok) return { ok: true }
      // 403: the person blocked the bot; 400 "chat not found": it never could write to them.
      return { ok: false, gone: response.status === 403 || response.status === 400, error: `telegram_${response.status}` }
    } catch {
      return { ok: false, gone: false, error: 'telegram_unreachable' }
    }
  },
}

let transport: ReminderTransport = realTransport

/** For tests: replace the transport; call with no argument to restore the real one. */
export function setReminderTransport(next?: ReminderTransport): void {
  transport = next ?? realTransport
}

export const reminderDeliveryService: ReminderTransport = {
  sendWebPush: (target, payload) => transport.sendWebPush(target, payload),
  sendTelegram: (chatId, text, buttonLabel) => transport.sendTelegram(chatId, text, buttonLabel),
}
