export enum LinkUserTelegramCommandErrorCode {
  /** No such account, or it is deleted. */
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The account already has a Telegram user, another one. */
  ALREADY_LINKED = 'ALREADY_LINKED',
  /** The Telegram user belongs to another account. */
  TELEGRAM_ALREADY_TAKEN = 'TELEGRAM_ALREADY_TAKEN',
}

export type LinkUserTelegramCommandResult =
  { success: true } | { success: false; error: LinkUserTelegramCommandErrorCode }
