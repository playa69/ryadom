import {
  CreateWeekSummaryOperation,
  CreateWeekSummaryOperationErrorCode,
  CreateWidgetTokenOperation,
  CreateWidgetTokenOperationErrorCode,
  diaryProcess,
  GetDiaryOperation,
  GetDiaryOperationErrorCode,
  ListWeekSummariesOperation,
  ListWeekSummariesOperationErrorCode,
  PutMoodCheckinOperation,
  PutMoodCheckinOperationErrorCode,
  ResolveWidgetTokenOperation,
  RevokeWidgetTokenOperation,
  type DiarySummaryDTO,
  type MoodCheckinDTO,
} from '@ryadom/core/processes/diary'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import assertNever from 'assert-never'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import {
  DiaryApiErrorCode,
  MOOD_FACTORS,
  type DiaryApiResponse,
  type DiarySummariesApiResponse,
  type DiarySummaryApi,
  type MoodCheckinApi,
  type MoodLevel,
  type PutMoodCheckinApiResponse,
  type WidgetTodayApiResponse,
  type WidgetTokenApiResponse,
} from '@ryadom/contracts/api/diary'
import { AppHeader } from '@ryadom/contracts/api/headers'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, apiOk, apiRefused } from '../../lib/api-response'
import { authUser, requireActiveSession, requireAuth } from '../../lib/auth-guard'
import type { AppEnv, RouteDeps } from '../../lib/context'
import { clientIp, RATE_LIMITS, type RateLimiter, type RateLimitRule } from '../../lib/rate-limit'
import { jsonBody, queryParams } from '../../lib/request'

/**
 * The mood diary (`REQ-WELL-01`, `openspec/specs/mood-diary`). On for everyone: there is no switch.
 *
 * Moods, factors and summary texts are the person's own: they reach their screens and, as codes, the
 * agent's summary route. They are not written to a log and not to product analytics, only the fact of
 * the action is (`mood_checked_in` without a value).
 */

const levelSchema = z.number().int().min(1).max(5)
const factorSchema = z.enum(MOOD_FACTORS)
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const putBody = z.object({
  mood: levelSchema,
  factor: factorSchema.nullable().optional(),
  date: dateSchema.optional(),
  source: z.enum(['app', 'reminder', 'telegram']).optional(),
})
const widgetCheckinBody = z.object({
  mood: levelSchema,
  factor: factorSchema.nullable().optional(),
  date: dateSchema.optional(),
})
const weekBody = z.object({ weekStart: dateSchema })
const summariesQuery = z.object({ kind: z.literal('week').optional(), before: dateSchema.optional() })

function perUser(limiter: RateLimiter, name: string, rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!(await limiter.hit(`user:${name}:${authUser(c).userId}`, rule))) return apiError(c, 429, 'Too many diary requests')
    return next()
  }
}

const toCheckin = (c: MoodCheckinDTO): MoodCheckinApi => ({ date: c.date, mood: c.mood as MoodLevel, factor: c.factor })
const toSummary = (s: DiarySummaryDTO): DiarySummaryApi => ({
  kind: s.kind,
  periodStart: s.periodStart,
  text: s.text,
  generatedAt: s.generatedAt.toISOString(),
  hardDays: typeof s.stats?.hardDays === 'number' ? s.stats.hardDays : 0,
})

/** Every way a diary operation can refuse; the meaning is the same in every route. */
type Refusal =
  | GetDiaryOperationErrorCode
  | PutMoodCheckinOperationErrorCode
  | ListWeekSummariesOperationErrorCode
  | CreateWeekSummaryOperationErrorCode

function refuse(c: Context, error: Refusal): Response {
  switch (error) {
    case GetDiaryOperationErrorCode.USER_NOT_FOUND:
    case PutMoodCheckinOperationErrorCode.USER_NOT_FOUND:
    case ListWeekSummariesOperationErrorCode.USER_NOT_FOUND:
    case CreateWeekSummaryOperationErrorCode.USER_NOT_FOUND:
      return apiError(c, 401, 'Unauthorised')
    case PutMoodCheckinOperationErrorCode.DATE_OUT_OF_RANGE:
    case CreateWeekSummaryOperationErrorCode.DATE_OUT_OF_RANGE:
      // A date from the client that is not today or yesterday of the person: the spec's 422 (REQ-WELL-01).
      return apiError(c, 422, 'The date must be today or yesterday in your time zone')
    case CreateWeekSummaryOperationErrorCode.NOT_ENOUGH_DAYS:
      return apiRefused(c, DiaryApiErrorCode.NOT_ENOUGH_DAYS, 'Not enough marked days')
    case CreateWeekSummaryOperationErrorCode.TOO_SOON:
      return apiRefused(c, DiaryApiErrorCode.TOO_SOON, 'The summary was re-run less than ten minutes ago')
    case CreateWeekSummaryOperationErrorCode.SUMMARY_UNAVAILABLE:
      return apiRefused(c, DiaryApiErrorCode.SUMMARY_UNAVAILABLE, 'The agent could not write the summary')
    default:
      return assertNever(error)
  }
}

export function diaryRoutes(app: Hono<AppEnv>, { jwt, rateLimiter, sessions, analytics }: RouteDeps): void {
  const read = perUser(rateLimiter, 'diary-read', RATE_LIMITS.diaryRead.perUser)
  const summary = perUser(rateLimiter, 'diary-summary', RATE_LIMITS.diarySummary.perUser)
  const write = perUser(rateLimiter, 'diary-write', RATE_LIMITS.diaryWrite.perUser)

  app.get(ApiPath.Diary, requireAuth(jwt), requireActiveSession(sessions), read, async (c) => {
    const result = await diaryProcess.execute(new GetDiaryOperation({ userId: authUser(c).userId }))
    if (!result.success) return refuse(c, result.error)
    const { diary } = result
    const body: DiaryApiResponse = {
      today: diary.today ? { mood: diary.today.mood as MoodLevel, factor: diary.today.factor } : null,
      recent: diary.recent.map(toCheckin),
      streak: diary.streak,
      week: {
        start: diary.week.start,
        markedDays: diary.week.markedDays,
        summary: diary.week.summary ? toSummary(diary.week.summary) : null,
      },
      previousWeek: diary.previousWeek ? toSummary(diary.previousWeek) : null,
    }
    return apiOk(c, body)
  })

  // One note per local day; a second replaces the first and keeps the factor unless the body names one.
  app.put(ApiPath.DiaryCheckinToday, requireAuth(jwt), requireActiveSession(sessions), write, jsonBody(putBody), async (c) => {
    const { userId } = authUser(c)
    const body = c.req.valid('json')
    const result = await diaryProcess.execute(
      new PutMoodCheckinOperation({
        userId,
        mood: body.mood,
        factor: body.factor,
        date: body.date,
        source: body.source ?? 'app',
      }),
    )
    if (!result.success) return refuse(c, result.error)
    // The fact of the note, never its value (design D12).
    analytics.capture(userId, AnalyticsEvent.MoodCheckedIn, {
      source: body.source ?? 'app',
      with_factor: result.checkin.factor !== null,
      changed: result.changed,
    })
    const response: PutMoodCheckinApiResponse = {
      checkin: toCheckin(result.checkin),
      changed: result.changed,
      hardStreak: result.hardStreak,
    }
    return apiOk(c, response)
  })

  app.get(ApiPath.DiarySummaries, requireAuth(jwt), requireActiveSession(sessions), read, queryParams(summariesQuery), async (c) => {
    const result = await diaryProcess.execute(
      new ListWeekSummariesOperation({ userId: authUser(c).userId, before: c.req.valid('query').before }),
    )
    if (!result.success) return refuse(c, result.error)
    const body: DiarySummariesApiResponse = { items: result.summaries.map(toSummary), nextBefore: result.nextBefore }
    return apiOk(c, body)
  })

  // «Обновить итоги»: the text of the current week again, now. The first text and the usual rewrites are the scheduler's.
  app.post(ApiPath.DiaryWeekSummary, requireAuth(jwt), requireActiveSession(sessions), summary, jsonBody(weekBody), async (c) => {
    const { userId } = authUser(c)
    const result = await diaryProcess.execute(new CreateWeekSummaryOperation({ userId, weekStart: c.req.valid('json').weekStart }))
    if (!result.success) return refuse(c, result.error)
    analytics.capture(userId, AnalyticsEvent.WeekSummaryGenerated, { trigger: 'button' })
    return apiOk(c, toSummary(result.summary))
  })

  // ─── the Android widget ────────────────────────────────────────────────────

  app.post(ApiPath.DiaryWidgetToken, requireAuth(jwt), requireActiveSession(sessions), write, async (c) => {
    const result = await diaryProcess.execute(new CreateWidgetTokenOperation({ userId: authUser(c).userId }))
    if (!result.success) {
      switch (result.error) {
        case CreateWidgetTokenOperationErrorCode.USER_NOT_FOUND:
          return apiError(c, 401, 'Unauthorised')
        default:
          return assertNever(result.error)
      }
    }
    const body: WidgetTokenApiResponse = { token: result.token }
    return apiOk(c, body)
  })

  app.delete(ApiPath.DiaryWidgetToken, requireAuth(jwt), requireActiveSession(sessions), write, async (c) => {
    await diaryProcess.execute(new RevokeWidgetTokenOperation({ userId: authUser(c).userId }))
    return apiOk(c, null)
  })

  /** `Authorization: Widget <token>`: the token can read today's note and write one, nothing else. */
  const widgetAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!(await rateLimiter.hit(`ip:widget:${clientIp(c)}`, RATE_LIMITS.widget.perIp))) {
      return apiError(c, 429, 'Too many requests: try again later')
    }
    const header = c.req.header(AppHeader.Authorization)
    const token = header?.startsWith('Widget ') ? header.slice('Widget '.length).trim() : ''
    if (!token) return apiError(c, 401, 'Unauthorised')
    const resolved = await diaryProcess.execute(new ResolveWidgetTokenOperation({ token }))
    if (!resolved.userId) return apiError(c, 401, 'Unauthorised')
    c.set('auth', { userId: resolved.userId, sessionId: null })
    return next()
  }

  app.get(ApiPath.DiaryWidgetToday, widgetAuth, async (c) => {
    const result = await diaryProcess.execute(new GetDiaryOperation({ userId: authUser(c).userId }))
    if (!result.success) return refuse(c, result.error)
    const today = result.diary.today
    const body: WidgetTodayApiResponse = {
      today: today ? { mood: today.mood as MoodLevel, factor: today.factor } : null,
    }
    return apiOk(c, body)
  })

  app.put(ApiPath.DiaryWidgetCheckin, widgetAuth, jsonBody(widgetCheckinBody), async (c) => {
    const { userId } = authUser(c)
    const body = c.req.valid('json')
    const result = await diaryProcess.execute(
      new PutMoodCheckinOperation({ userId, mood: body.mood, factor: body.factor, date: body.date, source: 'widget' }),
    )
    if (!result.success) return refuse(c, result.error)
    analytics.capture(userId, AnalyticsEvent.MoodCheckedIn, {
      source: 'widget',
      with_factor: result.checkin.factor !== null,
      changed: result.changed,
    })
    return apiOk(c, { checkin: toCheckin(result.checkin), changed: result.changed, hardStreak: result.hardStreak })
  })
}

