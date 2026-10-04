/**
 * `POST /api/auth/logout` — ends the session of a refresh token. The other devices of the person are
 * not signed out. The answer is always `null`: a token that is expired, forged or already ended is
 * a success too, because the outcome (no live session) is the same.
 */

export interface LogoutApiRequest {
  refreshToken: string
}
