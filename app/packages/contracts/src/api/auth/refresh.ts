/**
 * `POST /api/auth/refresh` — a new access token in exchange for a refresh token.
 *
 * The only place where the server looks at account state: an access token is verified by signature
 * alone and lives out its 15 minutes. The refresh token is not rotated. An expired or forged refresh
 * token, or a user who is gone, is a 401.
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
