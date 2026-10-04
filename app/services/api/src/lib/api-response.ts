import type { Context } from 'hono'
import type { ApiRefusalEnvelope, ApiSuccessEnvelope, ApiTransportErrorBody } from '@ryadom/contracts/api/envelope'

/**
 * The only way to answer from a route (enforced by test/conventions.test.ts):
 *
 * - `apiOk` for success: 200 with `{ status: true, result }`; actions without data use
 *   `result: null`;
 * - `apiRefused` when a route rule is violated: 200 with
 *   `{ status: false, errorCode, errorMessage }`, where the code is a member of the route's
 *   `XxxApiErrorCode` enum from its contract file;
 * - `apiError` for everything that is not a route answer: a status and `{ errorMessage }` with
 *   no code.
 *
 * `errorMessage` is English text for the logs. The wording shown to the person is chosen by the
 * screen.
 */

export function apiOk<T>(c: Context, result: T): Response {
  const body: ApiSuccessEnvelope<T> = { status: true, result }
  return c.json(body as never, 200)
}

export function apiRefused<C extends string>(c: Context, errorCode: C, errorMessage: string): Response {
  const body: ApiRefusalEnvelope<C> = { status: false, errorCode, errorMessage }
  return c.json(body as never, 200)
}

/**
 * - 400: the request was not understood (a client bug, fixed by an app update);
 * - 401: the token is missing or expired, or the email or password on login is wrong;
 * - 404: no such route;
 * - 413: the request body is too large;
 * - 422: a value failed an input rule that the route checks itself (the person can fix it);
 * - 426: the app version is below the minimum (version gate);
 * - 429: too often;
 * - 503: the dialog agent is unavailable, so a conversation is impossible but the hotlines remain;
 * - 5xx: a failure on our side.
 */
export type TransportErrorStatus = 400 | 401 | 404 | 413 | 422 | 426 | 429 | 500 | 501 | 502 | 503

export function apiError(c: Context, status: TransportErrorStatus, errorMessage: string): Response {
  const body: ApiTransportErrorBody = { errorMessage }
  return c.json(body, status)
}
