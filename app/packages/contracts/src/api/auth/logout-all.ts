/**
 * `POST /api/auth/logout-all` — ends every session of the person, or every one but the session that
 * asks ("sign out on the other devices"). Needs the access token, unlike `/api/auth/logout`: it acts
 * on the account and not on the one refresh token the client holds. The answer is `null`.
 *
 * With `keepCurrent` the session of the request stays. A token that carries no session (issued
 * before sessions existed) has none to keep, so everything ends.
 */

export interface LogoutAllApiRequest {
  keepCurrent: boolean
}
