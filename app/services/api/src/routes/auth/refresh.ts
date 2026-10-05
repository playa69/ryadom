import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '@ryadom/core/managers/users-manager'
import { authenticationProcess, RecordActivityOperation } from '@ryadom/core/processes/authentication'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { RefreshApiErrorCode, type RefreshApiResponse } from '@ryadom/contracts/api/auth/refresh'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { clientDevice } from '../../lib/client-device'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { jsonBody } from '../../lib/request'

/**
 * `POST /api/auth/refresh`. The only place where the server looks at account state: a deleted or
 * blocked account gets no new access token, while the old one lives out its 15 minutes. The account
 * is checked before the token is touched, so a refused refresh leaves the session as it was and
 * the client can tell "your account is blocked" from "your session is over".
 *
 * Every refresh token is single-use: the response carries a new pair, and the old refresh token is
 * retired (see `lib/sessions.ts` for what happens when it comes back).
 */
const bodySchema = z.object({
  refreshToken: z.string().min(1),
})

export function refreshRoutes(app: Hono<AppEnv>, { jwt, sessions }: RouteDeps): void {
  app.post(ApiPath.Refresh, jsonBody(bodySchema), async (c) => {
    const { refreshToken } = c.req.valid('json')
    const payload = await jwt.verifyToken(refreshToken, 'refresh')
    // A token with no `jti` was not issued by a registry-aware server: it cannot be rotated.
    if (!payload?.jti) return apiError(c, 401, 'Refresh token expired')

    const found = await usersManager.execute(new GetUserByIdQuery({ userId: payload.sub }))
    if (!found.success) {
      switch (found.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return apiError(c, 401, 'Unauthorised')
        default:
          return assertNever(found.error)
      }
    }
    if (found.user.isDeleted) return apiRefused(c, RefreshApiErrorCode.ACCOUNT_DELETED, 'Account deleted')
    if (!found.user.isActive) return apiRefused(c, RefreshApiErrorCode.ACCOUNT_INACTIVE, 'Account inactive')

    const rotated = await sessions.rotate({
      userId: payload.sub,
      tokenId: payload.jti,
      device: clientDevice(c),
    })
    if (!rotated.ok) {
      // An unknown, expired or retired token and a replayed one look the same from outside: the
      // session is over. The difference is in the log and in what the server did next.
      switch (rotated.reason) {
        case 'invalid':
        case 'replayed':
          return apiError(c, 401, 'Refresh token expired')
        default:
          return assertNever(rotated.reason)
      }
    }

    // A session lives for weeks: this is what tells the server the person is still opening the app.
    await authenticationProcess.execute(new RecordActivityOperation({ userId: payload.sub }))

    const response: RefreshApiResponse = rotated.tokens
    return apiOk(c, response)
  })
}
