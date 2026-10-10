import { consentVersionInputSchema } from '@ryadom/core/config'
import {
  AcceptConsentsOperation,
  AcceptConsentsOperationErrorCode,
  consentsProcess,
} from '@ryadom/core/processes/consents'
import assertNever from 'assert-never'
import type { Hono } from 'hono'
import { z } from 'zod'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import {
  AcceptConsentsApiErrorCode,
  type AcceptConsentsApiResponse,
} from '@ryadom/contracts/api/auth/consents'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { jsonBody } from '../../lib/request'
import { inputOrNull } from '../../lib/rules'

/**
 * `POST /api/auth/me/consents`: the three agreements of the first screen, recorded together under the
 * version of the terms the person was shown. A conversation is closed until they are on record
 * (`POST /api/dialogs` refuses with `CONSENT_REQUIRED`).
 */
const bodySchema = z.object({
  ageConfirmed: z.boolean(),
  disclaimerAccepted: z.boolean(),
  offerAccepted: z.boolean(),
  offerVersion: z.string(),
})

export function consentsRoutes(app: Hono<AppEnv>, { jwt, analytics }: RouteDeps): void {
  app.post(ApiPath.Consents, requireAuth(jwt), jsonBody(bodySchema), async (c) => {
    const body = c.req.valid('json')
    const offerVersion = inputOrNull(consentVersionInputSchema, body.offerVersion)
    if (offerVersion === null) return apiError(c, 422, 'The version of the terms is not a date')

    const result = await consentsProcess.execute(
      new AcceptConsentsOperation({
        userId: authUser(c).userId,
        ageConfirmed: body.ageConfirmed,
        disclaimerAccepted: body.disclaimerAccepted,
        offerAccepted: body.offerAccepted,
        offerVersion,
      }),
    )
    if (!result.success) {
      switch (result.error) {
        case AcceptConsentsOperationErrorCode.AGE_RESTRICTED:
          return apiRefused(c, AcceptConsentsApiErrorCode.AGE_RESTRICTED, 'The person is under 18')
        case AcceptConsentsOperationErrorCode.CONSENT_DECLINED:
          return apiRefused(c, AcceptConsentsApiErrorCode.CONSENT_DECLINED, 'The terms were not accepted')
        case AcceptConsentsOperationErrorCode.USER_NOT_FOUND:
          return apiRefused(c, AcceptConsentsApiErrorCode.USER_NOT_FOUND, 'User not found')
        default:
          return assertNever(result.error)
      }
    }
    analytics.capture(authUser(c).userId, AnalyticsEvent.ConsentsAccepted, { policy_version: offerVersion })
    const response: AcceptConsentsApiResponse = {
      consentsCompleted: true,
      acceptedAt: result.acceptedAt.toISOString(),
    }
    return apiOk(c, response)
  })
}
