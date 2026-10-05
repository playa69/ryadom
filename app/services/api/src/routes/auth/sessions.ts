import type { Hono } from 'hono'
import { z } from 'zod'
import { EndSessionApiErrorCode, type ListSessionsApiResponse } from '@ryadom/contracts/api/auth/sessions'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireActiveSession, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { toSession } from '../../lib/mappers'
import { jsonBody } from '../../lib/request'

/**
 * The person's own sessions. The user id always comes from the access token and never from the
 * request, so a session id taken from somebody else's list ends nothing: it is "not found", the
 * same as an id that never existed.
 *
 * - `GET /api/auth/sessions`: the open sessions, the current one marked;
 * - `DELETE /api/auth/sessions/:id`: ends one (the current one too, which is a sign-out);
 * - `POST /api/auth/logout-all`: ends all, or all but the current one.
 *
 * All three need a session that is still open, not only a token that is still signed: a device that
 * was signed out must not read the person's other devices or end them.
 */
const logoutAllBody = z.object({
  keepCurrent: z.boolean(),
})

export function sessionsRoutes(app: Hono<AppEnv>, { jwt, sessions }: RouteDeps): void {
  const requireOpenSession = requireActiveSession(sessions)

  app.get(ApiPath.Sessions, requireAuth(jwt), requireOpenSession, async (c) => {
    const { userId, sessionId } = authUser(c)
    const response: ListSessionsApiResponse = {
      sessions: (await sessions.list(userId)).map((session) => toSession(session, sessionId)),
    }
    return apiOk(c, response)
  })

  app.delete(`${ApiPath.Sessions}/:sessionId`, requireAuth(jwt), requireOpenSession, async (c) => {
    const { userId } = authUser(c)
    if (!(await sessions.endOne(userId, c.req.param('sessionId')))) {
      return apiRefused(c, EndSessionApiErrorCode.SESSION_NOT_FOUND, 'No such session')
    }
    return apiOk(c, null)
  })

  app.post(ApiPath.LogoutAll, requireAuth(jwt), requireOpenSession, jsonBody(logoutAllBody), async (c) => {
    const { userId, sessionId } = authUser(c)
    const { keepCurrent } = c.req.valid('json')
    await sessions.endAll(userId, keepCurrent ? sessionId : null)
    return apiOk(c, null)
  })
}
