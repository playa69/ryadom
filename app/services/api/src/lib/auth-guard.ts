import type { Context, MiddlewareHandler } from 'hono'
import { AppHeader } from '@ryadom/contracts/api/headers'
import { apiError } from './api-response'
import type { AppEnv } from './context'
import type { Jwt } from './jwt'

/**
 * Access token verification checks the signature only. Account state (deleted, blocked) is
 * checked when the token is refreshed, not on every request: an access token lives 15 minutes and
 * that delay is accepted, because a database query on every API call for the rare case of a block
 * is not worth its cost. `/api/auth/refresh` is where a deleted or blocked account is caught,
 * and it answers with a rule code the client acts on.
 */

export interface AuthUser {
  userId: string
}

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  return token || null
}

export async function getUserFromRequest(jwt: Jwt, authorization: string | undefined): Promise<AuthUser | null> {
  const token = bearerToken(authorization)
  if (!token) return null
  const payload = await jwt.verifyToken(token, 'access')
  return payload ? { userId: payload.sub } : null
}

/** Route for signed-in users only: without a valid token it is 401, and the client refreshes and retries. */
export function requireAuth(jwt: Jwt): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = await getUserFromRequest(jwt, c.req.header(AppHeader.Authorization))
    if (!user) return apiError(c, 401, 'Unauthorised')
    c.set('auth', user)
    await next()
  }
}

/** The user of a route behind `requireAuth`. */
export function authUser(c: Context<AppEnv>): AuthUser {
  const user = c.get('auth')
  if (!user) throw new Error('authUser() outside requireAuth')
  return user
}
