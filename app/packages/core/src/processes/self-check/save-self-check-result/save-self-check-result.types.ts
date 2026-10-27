import type { SelfCheckResultDTO } from '../../../managers/self-check-manager'
export enum SaveSelfCheckResultOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The person has not agreed to keep results (`user_consents`, kind `self_check`). */
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
  /** No such test. */
  UNKNOWN_TEST = 'UNKNOWN_TEST',
  /** The client's description of the test is older or newer than the server's. */
  UNKNOWN_VERSION = 'UNKNOWN_VERSION',
  /** The answers do not fit the test: the count or a value out of the options. */
  INVALID_ANSWERS = 'INVALID_ANSWERS',
}

export type SaveSelfCheckResultResult =
  | { success: true; result: SelfCheckResultDTO }
  | { success: false; error: SaveSelfCheckResultOperationErrorCode }
