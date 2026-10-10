import { passwordInputSchema } from '@ryadom/core/config'
import {
  ChangePasswordOperation,
  ChangePasswordOperationErrorCode,
  changePasswordProcess,
} from '@ryadom/core/processes/change-password'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { ChangePasswordApiErrorCode } from '@ryadom/contracts/api/auth/password'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { jsonBody } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/** `POST /api/auth/password` — change the password using the current one. */
const changeBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1),
})

export function passwordRoutes(app: Hono<AppEnv>, { jwt, analytics }: RouteDeps): void {
  app.post(ApiPath.Password, requireAuth(jwt), jsonBody(changeBody), async (c) => {
    const body = c.req.valid('json')
    const newPassword = inputOrNull(passwordInputSchema, body.newPassword)
    if (newPassword === null) return apiError(c, 422, 'Password length is out of range')

    const { userId, sessionId } = authUser(c)

    const result = await changePasswordProcess.execute(
      new ChangePasswordOperation({
        userId,
        currentPassword: body.currentPassword,
        newPassword,
        // The session that makes the change stays signed in, every other one ends.
        keepSessionId: sessionId,
      }),
    )
    if (!result.success) {
      // A wrong current password is human input, not an expired session: a rule code, not a 401.
      switch (result.error) {
        case ChangePasswordOperationErrorCode.INVALID_CURRENT_PASSWORD:
          return apiRefused(c, ChangePasswordApiErrorCode.INVALID_CURRENT_PASSWORD, 'Invalid current password')
        case ChangePasswordOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, ChangePasswordApiErrorCode.USER_NOT_FOUND, 'User not found')
        default:
          return assertNever(result.error)
      }
    }
    analytics.capture(userId, AnalyticsEvent.PasswordChanged)
    return apiOk(c, null)
  })
}
