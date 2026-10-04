/**
 * The response envelope of the app API.
 *
 * Both a success and a violated rule are route answers, and both travel in an envelope with
 * status 200: `{ status: true, result }` or `{ status: false, errorCode, errorMessage }`. The rule
 * code is declared as an enum in the route's contract file, and the screen is what interprets it.
 * Actions without data use `result: null`.
 *
 * Everything else, such as a request that was not understood, a missing token, an input rule, the
 * version gate or a failure, is an HTTP status with a `{ errorMessage }` body and no code: a second
 * dictionary layered on top of the statuses would drift away from the first.
 *
 * Files in src/shared end up in the app bundle, so this file holds only types and enums, with no
 * runtime imports.
 */

/** Success: the data is in `result`, and actions without data use `null`. */
export interface ApiSuccessEnvelope<T> {
  status: true
  result: T
}

/** A refusal by a route rule. */
export interface ApiRefusalEnvelope<C extends string = string> {
  status: false
  /** A code from this route's `XxxApiErrorCode` enum. */
  errorCode: C
  /** English text for the logs; the interface never shows it. */
  errorMessage: string
}

export type ApiEnvelope<T, C extends string = string> = ApiSuccessEnvelope<T> | ApiRefusalEnvelope<C>

/**
 * The body of any non-200 response: 400, 401, 404, 422, 426, 5xx. There is no code, because the
 * status carries the meaning.
 */
export interface ApiTransportErrorBody {
  errorMessage: string
}
