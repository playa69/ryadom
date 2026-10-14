import type { UserDTO } from '../../../managers/users-manager'

export enum TelegramLoginOperationErrorCode {
  /** No bot token is configured: sign-in from Telegram is off. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** The launch data is not our bot's. */
  INIT_DATA_INVALID = 'INIT_DATA_INVALID',
  /** The launch data is ours but too old: the Mini App has to be opened again. */
  INIT_DATA_EXPIRED = 'INIT_DATA_EXPIRED',
  /** This Telegram user has no account, and none was asked for. */
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  /** The account of this Telegram user is blocked. */
  USER_INACTIVE = 'USER_INACTIVE',
}

export type TelegramLoginResult =
  | {
      success: true
      user: UserDTO
      /** true when this call made the account. */
      isNewAccount: boolean
    }
  | { success: false; error: TelegramLoginOperationErrorCode }
