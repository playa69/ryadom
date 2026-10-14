import type { LoginApiResponse } from './shared'

/**
 * Sign-in from the Telegram Mini App.
 *
 * Telegram hands the Mini App its launch data (`Telegram.WebApp.initData`): the person's Telegram
 * user and the time the Mini App was opened, signed with a key of our bot. The app sends it as it is;
 * the server checks the signature and the age, and the Telegram user is who the person is.
 *
 * `POST /api/auth/telegram` — the account of this Telegram user. With `createAccount` a Telegram user
 * that has none gets one (the first screen, after the agreements); without it the answer is
 * `ACCOUNT_NOT_FOUND` and nothing is made (the silent sign-in at launch).
 *
 * `POST /api/auth/telegram/link` (signed in) — the account takes the Telegram user of the Mini App, so
 * that the Mini App opens it from then on. A Telegram user that already has an account keeps it.
 *
 * A request without `initData` is a 400.
 */

export interface TelegramLoginApiRequest {
  initData: string
  createAccount?: boolean
}

export interface TelegramLoginApiResponse extends LoginApiResponse {
  /** true when this call made the account. */
  isNewAccount: boolean
}

export enum TelegramLoginApiErrorCode {
  /** The server has no bot configured: Telegram sign-in is off. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** The launch data is not our bot's. */
  INIT_DATA_INVALID = 'INIT_DATA_INVALID',
  /** The launch data is too old: the Mini App has to be closed and opened again. */
  INIT_DATA_EXPIRED = 'INIT_DATA_EXPIRED',
  /** This Telegram user has no account (only without `createAccount`). */
  ACCOUNT_NOT_FOUND = 'ACCOUNT_NOT_FOUND',
  /** The account is blocked. */
  USER_INACTIVE = 'USER_INACTIVE',
}

export interface LinkTelegramApiRequest {
  initData: string
}

export interface LinkTelegramApiResponse {
  telegramLinked: true
}

export enum LinkTelegramApiErrorCode {
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  INIT_DATA_INVALID = 'INIT_DATA_INVALID',
  INIT_DATA_EXPIRED = 'INIT_DATA_EXPIRED',
  /** This Telegram user already has another account. */
  TELEGRAM_TAKEN = 'TELEGRAM_TAKEN',
  /** The account already has another Telegram user. */
  ALREADY_LINKED = 'ALREADY_LINKED',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  USER_INACTIVE = 'USER_INACTIVE',
}
