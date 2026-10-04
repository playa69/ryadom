import { GetUserByIdQuery, GetUserByIdQueryErrorCode, usersManager } from '@ryadom/core/managers/users-manager'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { RefreshApiErrorCode, type RefreshApiResponse } from '@ryadom/contracts/api/auth/refresh'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { ACCESS_TTL_SECONDS } from '../../lib/jwt'
import { jsonBody } from '../../lib/request'

/**
 * `POST /api/auth/refresh`. The only place where the server looks at account state: a deleted or
 * blocked account gets no new access token, while the old one lives out its 15 minutes. The refresh
 * token is not rotated, so the response carries a new access token and the same refresh token.
 */
const bodySchema = z.object({
  refreshToken: z.string().min(1),
})

export function refreshRoutes(app: Hono<AppEnv>, { jwt }: RouteDeps): void {
  app.post(ApiPath.Refresh, jsonBody(bodySchema), async (c) => {
    const { refreshToken } = c.req.valid('json')
    const payload = await jwt.verifyToken(refreshToken, 'refresh')
    if (!payload) return apiError(c, 401, 'Refresh token expired')

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

    const response: RefreshApiResponse = {
      accessToken: await jwt.signAccessToken(payload.sub),
      refreshToken,
      expiresAt: Date.now() + ACCESS_TTL_SECONDS * 1000,
    }
    return apiOk(c, response)
  })
}
