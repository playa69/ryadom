/**
 * `POST /api/auth/refresh` — a new token pair in exchange for a refresh token.
 *
 * The only place where the server looks at account state: an access token is verified by signature
 * alone and lives out its 15 minutes.
 *
 * A refresh token is single-use. The response carries a new one, which the client must store in
 * place of the old: the old one is retired. If the response is lost, repeating the request within a
 * few seconds works; later, a retired token is a 401 and also ends every session of the person,
 * because it can only come from a copy that was kept. An expired, forged or already ended refresh
 * token, or a user who is gone, is a 401 as well.
 */

export enum RefreshApiErrorCode {
  /** The account is deleted: the session must be terminated. */
  ACCOUNT_DELETED = 'ACCOUNT_DELETED',
  /** The account is blocked: the session must be terminated. */
  ACCOUNT_INACTIVE = 'ACCOUNT_INACTIVE',
}

export interface RefreshApiRequest {
  refreshToken: string
}

export interface RefreshApiResponse {
  accessToken: string
  refreshToken: string
  /** Unix time in milliseconds when the access token expires. */
  expiresAt: number
}
