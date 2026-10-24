import type { TelegramInitDataUser } from '../init-data'

export enum VerifyInitDataRequestErrorCode {
  /** No bot token is configured: sign-in from Telegram is off. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** Not launch data of our bot: a wrong signature or a shape Telegram does not make. */
  INVALID = 'INVALID',
  /** Signed by our bot, but older than `TELEGRAM_INIT_DATA_MAX_AGE_SEC`. */
  EXPIRED = 'EXPIRED',
}

export type VerifyInitDataRequestResult =
  | { success: true; telegramUser: TelegramInitDataUser }
  | { success: false; error: VerifyInitDataRequestErrorCode }
