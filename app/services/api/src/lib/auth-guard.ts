import type { Context, MiddlewareHandler } from 'hono'
import { updateRequestContext } from '@ryadom/core/shared'
import { AppHeader } from '@ryadom/contracts/api/headers'
import { apiError } from './api-response'
import type { AppEnv } from './context'
import type { Jwt } from './jwt'
import type { Sessions } from './sessions'

/**
 * Access token verification checks the signature only. Account state (deleted, blocked) is
 * checked when the token is refreshed, not on every request: an access token lives 15 minutes and
 * that delay is accepted, because a database query on every API call for the rare case of a block
 * is not worth its cost. The few routes where a token of an ended session must not work even for
 * those minutes put `requireActiveSession` behind `requireAuth`. `/api/auth/refresh` is where a
 * deleted or blocked account is caught,
 * and it answers with a rule code the client acts on.
 */

export interface AuthUser {
  userId: string
  /** The session the token belongs to; null for a token issued before sessions existed. */
  sessionId: string | null
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

async function getUserFromRequest(jwt: Jwt, authorization: string | undefined): Promise<AuthUser | null> {
  const token = bearerToken(authorization)
  if (!token) return null
  const payload = await jwt.verifyToken(token, 'access')
  return payload ? { userId: payload.sub, sessionId: payload.sid ?? null } : null
}

/** Route for signed-in users only: without a valid token it is 401, and the client refreshes and retries. */
export function requireAuth(jwt: Jwt): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = await getUserFromRequest(jwt, c.req.header(AppHeader.Authorization))
    if (!user) return apiError(c, 401, 'Unauthorised')
    c.set('auth', user)
    // `x-user-id` is whatever the client wrote; behind a verified token the log and the agent get the account.
    updateRequestContext({ userId: user.userId })
    await next()
  }
}

/**
 * For routes that serve people with and without a session (confirming an address): no token at all
 * passes as nobody, a token that is expired or whose session has ended is the same 401 as behind
 * `requireAuth` (the client refreshes and asks again), and a good one sets `auth` as usual. A bad
 * token must not pass as nobody: the person would be treated as a stranger on their own account.
 */
export function optionalAuth(jwt: Jwt, sessions: Pick<Sessions, 'isActive'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header(AppHeader.Authorization)
    if (bearerToken(header) === null) return next()
    const user = await getUserFromRequest(jwt, header)
    if (!user) return apiError(c, 401, 'Unauthorised')
    if (user.sessionId && !(await sessions.isActive(user.sessionId))) return apiError(c, 401, 'Session ended')
    c.set('auth', user)
    updateRequestContext({ userId: user.userId })
    await next()
  }
}

/**
 * For routes that act on the account or open a conversation, behind `requireAuth`: the session of
 * the token must still be open. A signature that is still good proves nothing about a session that
 * was ended after the token was issued, and a device that was signed out must not be able to end
 * the real owner's other sessions, or read the list of them, on the strength of it. The answer is
 * the 401 of an expired token: the client refreshes, finds the session gone and signs the person out.
 * A token with no session (issued before sessions existed) has none to ask about.
 */
export function requireActiveSession(sessions: Pick<Sessions, 'isActive'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { sessionId } = authUser(c)
    if (sessionId && !(await sessions.isActive(sessionId))) return apiError(c, 401, 'Session ended')
    await next()
  }
}

/** The user of a route behind `requireAuth`. */
export function authUser(c: Context<AppEnv>): AuthUser {
  const user = c.get('auth')
  if (!user) throw new Error('authUser() outside requireAuth')
  return user
}
