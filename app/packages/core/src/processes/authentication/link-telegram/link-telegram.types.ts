export enum LinkTelegramOperationErrorCode {
  /** No bot token is configured: Telegram is off. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** The launch data is not our bot's. */
  INIT_DATA_INVALID = 'INIT_DATA_INVALID',
  /** The launch data is ours but too old: the Mini App has to be opened again. */
  INIT_DATA_EXPIRED = 'INIT_DATA_EXPIRED',
  /** This Telegram user already has another account. */
  TELEGRAM_TAKEN = 'TELEGRAM_TAKEN',
  /** The account already has another Telegram user. */
  ALREADY_LINKED = 'ALREADY_LINKED',
  /** The account is gone. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The account is blocked. */
  USER_INACTIVE = 'USER_INACTIVE',
}

export type LinkTelegramResult = { success: true } | { success: false; error: LinkTelegramOperationErrorCode }
