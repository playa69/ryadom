import type { Hono } from 'hono'
import { z } from 'zod'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiOk } from '../../lib/api-response'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { limitByIp, RATE_LIMITS } from '../../lib/rate-limit'
import { jsonBody } from '../../lib/request'

/**
 * `POST /api/auth/logout`: ends the session the refresh token belongs to; the other devices of the
 * person keep theirs. It is the refresh token that identifies the session, not the access token:
 * the client calls this on its way out, when the access token may already be gone.
 *
 * The answer is always success. A token that is expired, forged or already ended leaves the same
 * state behind (no live session), and a different answer would only tell a guesser which tokens
 * were real.
 */
const bodySchema = z.object({
  refreshToken: z.string().min(1),
})

export function logoutRoutes(app: Hono<AppEnv>, { jwt, sessions, rateLimiter }: RouteDeps): void {
  app.post(
    ApiPath.Logout,
    limitByIp(rateLimiter, 'logout', RATE_LIMITS.attempt.perIp),
    jsonBody(bodySchema),
    async (c) => {
      const { refreshToken } = c.req.valid('json')
      const payload = await jwt.verifyToken(refreshToken, 'refresh')
      if (payload?.jti) await sessions.end(payload.jti)
      return apiOk(c, null)
    },
  )
}
