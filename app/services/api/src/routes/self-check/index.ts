import { AnalyticsEvent } from '@ryadom/analytics/events'
import {
  DeleteSelfCheckResultsOperation,
  GetSelfCheckConsentOperation,
  GiveSelfCheckConsentOperation,
  LatestSelfCheckResultsOperation,
  ListSelfCheckResultsOperation,
  RevokeSelfCheckConsentOperation,
  SaveSelfCheckResultOperation,
  SaveSelfCheckResultOperationErrorCode,
  selfCheckProcess,
} from '@ryadom/core/processes/self-check'
import type { SelfCheckResultDTO } from '@ryadom/core/managers/self-check-manager'
import { ApiPath } from '@ryadom/contracts/api/paths'
import {
  SelfCheckApiErrorCode,
  type DeleteSelfCheckApiResponse,
  type SelfCheckConsentApiResponse,
  type SelfCheckLatestApiResponse,
  type SelfCheckResultApi,
  type SelfCheckResultsApiResponse,
} from '@ryadom/contracts/api/self-check'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireActiveSession, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { byId } from '@ryadom/self-check/catalog'
import { selfCheckCrisisTotal } from '../../lib/metrics'
import { clientIp, RATE_LIMITS, type RateLimiter, type RateLimitRule } from '../../lib/rate-limit'
import { jsonBody, queryParams } from '../../lib/request'

/**
 * Tests inside the app (`REQ-WELL-06`…`08`, `openspec/specs/self-check`).
 *
 * What a person answers is the most private thing the app holds: the answers reach this process only to be
 * counted again and are not stored, not logged and not sent to analytics. Scores and levels are stored for the
 * person's own screens and are not reported either: product analytics gets the fact of the action and the test id.
 */

const uuidSchema = z.uuid()
const saveBody = z.object({
  testId: z.string().min(1).max(64),
  testVersion: z.number().int().min(1),
  // The values of the options; the counts and ranges are the test's rules, answered with 422.
  answers: z.array(z.number().int().min(0).max(10)).min(1).max(60),
  takenAt: z.iso.datetime().optional(),
})
const resultsQuery = z.object({
  testId: z.string().min(1).max(64).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})
const deleteQuery = z.object({ testId: z.string().min(1).max(64).optional() })

function perUser(limiter: RateLimiter, name: string, rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!(await limiter.hit(`user:${name}:${authUser(c).userId}`, rule)))
      return apiError(c, 429, 'Too many test requests')
    return next()
  }
}

const toResult = (r: SelfCheckResultDTO): SelfCheckResultApi => ({
  id: r.id,
  testId: r.testId,
  testVersion: r.testVersion,
  score: r.score,
  subscores: r.subscores,
  band: r.band,
  takenAt: r.takenAt.toISOString(),
})

const unauthorised = (c: Context) => apiError(c, 401, 'Unauthorised')

export function selfCheckRoutes(
  app: Hono<AppEnv>,
  { jwt, rateLimiter, sessions, analytics }: RouteDeps,
): void {
  const read = perUser(rateLimiter, 'self-check-read', RATE_LIMITS.selfCheckRead.perUser)
  const write = perUser(rateLimiter, 'self-check-write', RATE_LIMITS.selfCheckWrite.perUser)
  const guard = [requireAuth(jwt), requireActiveSession(sessions)] as const

  // A crisis answer was given on a client: only the counter grows. No sign-in and no account: nothing here knows whose
  // answer it is, and nothing is written down but «this test, once more». An unknown test id is ignored.
  app.post(ApiPath.SelfCheckCrisis, jsonBody(z.object({ testId: z.string().min(1).max(64) })), async (c) => {
    if (!(await rateLimiter.hit(`ip:self-check-crisis:${clientIp(c)}`, RATE_LIMITS.selfCheckCrisis.perIp))) {
      return apiError(c, 429, 'Too many requests')
    }
    const test = byId(c.req.valid('json').testId)
    if (test) selfCheckCrisisTotal.inc({ test: test.id })
    return apiOk(c, null)
  })

  app.get(ApiPath.SelfCheckLatest, ...guard, read, async (c) => {
    const result = await selfCheckProcess.execute(
      new LatestSelfCheckResultsOperation({ userId: authUser(c).userId }),
    )
    if (!result.success) return unauthorised(c)
    const body: SelfCheckLatestApiResponse = { items: result.results.map(toResult) }
    return apiOk(c, body)
  })

  app.get(ApiPath.SelfCheckResults, ...guard, read, queryParams(resultsQuery), async (c) => {
    const q = c.req.valid('query')
    const result = await selfCheckProcess.execute(
      new ListSelfCheckResultsOperation({
        userId: authUser(c).userId,
        testId: q.testId,
        before: q.before ? new Date(q.before) : undefined,
        limit: q.limit,
      }),
    )
    if (!result.success) return unauthorised(c)
    const body: SelfCheckResultsApiResponse = {
      items: result.results.map(toResult),
      nextBefore: result.nextBefore ? result.nextBefore.toISOString() : null,
    }
    return apiOk(c, body)
  })

  app.post(ApiPath.SelfCheckResults, ...guard, write, jsonBody(saveBody), async (c) => {
    const { userId } = authUser(c)
    const body = c.req.valid('json')
    const result = await selfCheckProcess.execute(
      new SaveSelfCheckResultOperation({
        userId,
        testId: body.testId,
        testVersion: body.testVersion,
        answers: body.answers,
        takenAt: body.takenAt ? new Date(body.takenAt) : undefined,
      }),
    )
    if (!result.success) {
      switch (result.error) {
        case SaveSelfCheckResultOperationErrorCode.USER_NOT_FOUND:
          return unauthorised(c)
        case SaveSelfCheckResultOperationErrorCode.CONSENT_REQUIRED:
          return apiRefused(
            c,
            SelfCheckApiErrorCode.CONSENT_REQUIRED,
            'The person has not agreed to keep results',
          )
        case SaveSelfCheckResultOperationErrorCode.UNKNOWN_TEST:
        case SaveSelfCheckResultOperationErrorCode.UNKNOWN_VERSION:
        case SaveSelfCheckResultOperationErrorCode.INVALID_ANSWERS:
          return apiError(c, 422, 'The test, its version or the answers are not valid')
      }
    }
    // The fact of saving and which test; never the score, the level or the answers.
    analytics.capture(userId, AnalyticsEvent.SelfCheckSaved, { test_id: result.result.testId })
    return apiOk(c, toResult(result.result))
  })

  // All results of one test (`?testId=`) or all of them (no query).
  app.delete(ApiPath.SelfCheckResults, ...guard, write, queryParams(deleteQuery), async (c) => {
    const { userId } = authUser(c)
    const result = await selfCheckProcess.execute(
      new DeleteSelfCheckResultsOperation({ userId, testId: c.req.valid('query').testId }),
    )
    if (!result.success) return unauthorised(c)
    analytics.capture(userId, AnalyticsEvent.SelfCheckResultDeleted, {
      scope: c.req.valid('query').testId ? 'test' : 'all',
    })
    const body: DeleteSelfCheckApiResponse = { deleted: result.deleted }
    return apiOk(c, body)
  })

  app.delete(`${ApiPath.SelfCheckResults}/:id`, ...guard, write, async (c) => {
    const { userId } = authUser(c)
    const id = uuidSchema.safeParse(c.req.param('id'))
    if (!id.success) return apiError(c, 404, 'Not found')
    const result = await selfCheckProcess.execute(
      new DeleteSelfCheckResultsOperation({ userId, resultId: id.data }),
    )
    if (!result.success) return unauthorised(c)
    // A result that is not the person's own, or is already gone, is "not found", never a hint of whose it is.
    if (result.deleted === 0) return apiError(c, 404, 'Not found')
    analytics.capture(userId, AnalyticsEvent.SelfCheckResultDeleted, { scope: 'one' })
    const body: DeleteSelfCheckApiResponse = { deleted: result.deleted }
    return apiOk(c, body)
  })

  app.get(ApiPath.SelfCheckConsent, ...guard, read, async (c) => {
    const result = await selfCheckProcess.execute(
      new GetSelfCheckConsentOperation({ userId: authUser(c).userId }),
    )
    if (!result.success) return unauthorised(c)
    const body: SelfCheckConsentApiResponse = { given: result.version !== null, version: result.version }
    return apiOk(c, body)
  })

  app.post(
    ApiPath.SelfCheckConsent,
    ...guard,
    write,
    jsonBody(z.object({ version: z.string().min(1).max(32) })),
    async (c) => {
      const result = await selfCheckProcess.execute(
        new GiveSelfCheckConsentOperation({
          userId: authUser(c).userId,
          version: c.req.valid('json').version,
        }),
      )
      if (!result.success) return unauthorised(c)
      const body: SelfCheckConsentApiResponse = { given: true, version: result.version }
      return apiOk(c, body)
    },
  )

  // Withdrawing the consent removes every saved result with it.
  app.delete(ApiPath.SelfCheckConsent, ...guard, write, async (c) => {
    const { userId } = authUser(c)
    const result = await selfCheckProcess.execute(new RevokeSelfCheckConsentOperation({ userId }))
    if (!result.success) return unauthorised(c)
    analytics.capture(userId, AnalyticsEvent.SelfCheckConsentRevoked)
    const body: DeleteSelfCheckApiResponse = { deleted: result.deleted }
    return apiOk(c, body)
  })
}
