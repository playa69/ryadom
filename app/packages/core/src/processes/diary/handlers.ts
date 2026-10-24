import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, gte } from 'drizzle-orm'
import { moodCheckins, users } from '@ryadom/db/schema'
import { getDb, createLogger } from '../../shared'
import {
  DeleteUserDiaryCommand,
  ListDiarySummariesQuery,
  ListMoodCheckinsQuery,
  UpsertDiarySummaryCommand,
  UpsertMoodCheckinCommand,
  diaryManager,
  type DiarySummaryDTO,
  type MoodCheckinDTO,
} from '../../managers/diary-manager'
import { GetNotificationSettingsQuery, notificationsManager } from '../../managers/notifications-manager'
import { GetUserByIdQuery, usersManager } from '../../managers/users-manager'
import {
  CreateAgentDigestRequest,
  GetAgentMemoryRequest,
  agentApiIntegration,
  type AgentDigestMark,
} from '../../integrations/agent-api'
import { AgentUnavailableError } from '../../shared'
import { addDaysToDate, isValidDate, localMoment, weekStart } from '../../diary/local-time'
import {
  CreateWeekSummaryOperation,
  CreateYearStoryOperation,
  DeleteDiaryDataOperation,
  DiaryOperationErrorCode,
  GetDiaryEventsOperation,
  GetDiaryOperation,
  GetYearOperation,
  ListWeekSummariesOperation,
  PutMoodCheckinOperation,
  RunWeeklyDigestsOperation,
  type DiaryView,
  type YearView,
} from './operations'

const log = createLogger('diary')

export const WEEK_SUMMARY_MIN_DAYS = 3
export const YEAR_STORY_MIN_WEEKS = 6
export const YEAR_STORY_EXTEND_WEEKS = 4
const SUMMARY_COOLDOWN_MS = 24 * 60 * 60 * 1000

const fail = (error: DiaryOperationErrorCode) => ({ success: false as const, error })

async function userZone(userId: string): Promise<string | null> {
  const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
  return found.success && !found.user.isDeleted ? found.user.timezone : null
}

async function checkins(userId: string, from: string, to: string): Promise<MoodCheckinDTO[]> {
  return (await diaryManager.execute(new ListMoodCheckinsQuery({ userId, from, to }))).checkins
}

const toMarks = (days: readonly MoodCheckinDTO[]): AgentDigestMark[] =>
  days.map((d) => ({ date: d.date, mood: d.mood, factor: d.factor }))

function monthRange(month: string): { from: string; to: string } | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null
  const [y, m] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

@requestHandler(GetDiaryOperation)
export class GetDiaryOperationHandler implements RequestHandler<GetDiaryOperation, Awaited<ReturnType<typeof GetDiaryOperationHandler.prototype.handle>>> {
  async handle(operation: GetDiaryOperation) {
    const { userId, month, now = new Date() } = operation.data
    const zone = await userZone(userId)
    if (!zone) return fail(DiaryOperationErrorCode.USER_NOT_FOUND)
    const local = localMoment(now, zone)
    const range = monthRange(month ?? local.date.slice(0, 7))
    if (!range) return fail(DiaryOperationErrorCode.DATE_OUT_OF_RANGE)
    const start = weekStart(local.date)
    const [monthDays, weekDays, summaries, settings] = await Promise.all([
      checkins(userId, range.from, range.to),
      checkins(userId, start, addDaysToDate(start, 6)),
      diaryManager.execute(new ListDiarySummariesQuery({ userId, kind: 'week', from: start, to: start, limit: 1 })),
      notificationsManager.execute(new GetNotificationSettingsQuery({ userId })),
    ])
    const today = weekDays.find((d) => d.date === local.date) ?? null
    const diary: DiaryView = {
      today,
      month: monthDays,
      week: { start, markedDays: weekDays.length, summary: summaries.summaries[0] ?? null },
      reminder: {
        enabled: settings.settings.moodReminderEnabled,
        time: settings.settings.moodReminderTime,
        paused: settings.settings.paused,
        offerAnswered: settings.settings.offerAnswered,
      },
    }
    return { success: true as const, diary }
  }
}

/** Days of "hard" in a row ending at `date`, as long as the notes exist. */
async function hardStreakEnding(userId: string, date: string): Promise<number> {
  const recent = await checkins(userId, addDaysToDate(date, -6), date)
  const byDate = new Map(recent.map((d) => [d.date, d.mood]))
  let streak = 0
  for (let day = date; byDate.get(day) === 1; day = addDaysToDate(day, -1)) streak += 1
  return streak
}

@requestHandler(PutMoodCheckinOperation)
export class PutMoodCheckinOperationHandler implements RequestHandler<PutMoodCheckinOperation, Awaited<ReturnType<typeof PutMoodCheckinOperationHandler.prototype.handle>>> {
  async handle(operation: PutMoodCheckinOperation) {
    const { userId, mood, factor, date, source, now = new Date() } = operation.data
    const zone = await userZone(userId)
    if (!zone) return fail(DiaryOperationErrorCode.USER_NOT_FOUND)
    const today = localMoment(now, zone).date
    // Only today counts; yesterday is allowed for a note queued without network (design D2, D5).
    const localDate = date ?? today
    if (!isValidDate(localDate) || (localDate !== today && localDate !== addDaysToDate(today, -1))) {
      return fail(DiaryOperationErrorCode.DATE_OUT_OF_RANGE)
    }
    const saved = await diaryManager.execute(new UpsertMoodCheckinCommand({ userId, localDate, mood, factor, source }))
    const hardStreak = saved.checkin.mood === 1 ? await hardStreakEnding(userId, localDate) : 0
    return { success: true as const, checkin: saved.checkin, changed: saved.changed, hardStreak }
  }
}

async function finalWeekSummaries(userId: string, year: number): Promise<DiarySummaryDTO[]> {
  const { summaries } = await diaryManager.execute(
    new ListDiarySummariesQuery({ userId, kind: 'week', from: `${year}-01-01`, to: `${year}-12-31`, limit: 60 }),
  )
  return summaries.filter((s) => s.stats?.final === true)
}

async function yearStory(userId: string, year: number): Promise<DiarySummaryDTO | null> {
  const { summaries } = await diaryManager.execute(
    new ListDiarySummariesQuery({ userId, kind: 'year', from: `${year}-01-01`, to: `${year}-01-01`, limit: 1 }),
  )
  return summaries[0] ?? null
}

@requestHandler(GetYearOperation)
export class GetYearOperationHandler implements RequestHandler<GetYearOperation, Awaited<ReturnType<typeof GetYearOperationHandler.prototype.handle>>> {
  async handle(operation: GetYearOperation) {
    const { userId, now = new Date() } = operation.data
    const zone = await userZone(userId)
    if (!zone) return fail(DiaryOperationErrorCode.USER_NOT_FOUND)
    const year = operation.data.year ?? Number(localMoment(now, zone).date.slice(0, 4))
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return fail(DiaryOperationErrorCode.DATE_OUT_OF_RANGE)
    const days = await checkins(userId, `${year}-01-01`, `${year}-12-31`)
    const [weekly, story] = await Promise.all([finalWeekSummaries(userId, year), yearStory(userId, year)])
    const counts = new Map<number, number>()
    for (const d of days) counts.set(d.mood, (counts.get(d.mood) ?? 0) + 1)
    let mostFrequent: number | null = null
    let best = 0
    for (const level of [1, 2, 3, 4, 5]) {
      const count = counts.get(level) ?? 0
      if (count > 0 && count >= best) {
        mostFrequent = level
        best = count
      }
    }
    const view: YearView = {
      year,
      days,
      markedDays: days.length,
      mostFrequent,
      weeklyCount: weekly.length,
      story: story
        ? { text: story.text, generatedAt: story.generatedAt, weeklyCount: Number(story.stats?.weeklyCount ?? 0) }
        : null,
    }
    return { success: true as const, year: view }
  }
}

@requestHandler(ListWeekSummariesOperation)
export class ListWeekSummariesOperationHandler implements RequestHandler<ListWeekSummariesOperation, Awaited<ReturnType<typeof ListWeekSummariesOperationHandler.prototype.handle>>> {
  async handle(operation: ListWeekSummariesOperation) {
    const { userId, before } = operation.data
    if (!(await userZone(userId))) return fail(DiaryOperationErrorCode.USER_NOT_FOUND)
    const pageSize = 20
    const { summaries } = await diaryManager.execute(
      new ListDiarySummariesQuery({ userId, kind: 'week', before, limit: pageSize + 1 }),
    )
    const page = summaries.slice(0, pageSize)
    return {
      success: true as const,
      summaries: page,
      nextBefore: summaries.length > pageSize ? (page[page.length - 1]?.periodStart ?? null) : null,
    }
  }
}

/** Asks the agent for a week text; null when it cannot write one. A down agent is not an error of ours. */
async function writeDigest(
  userId: string,
  kind: 'week' | 'year',
  periodStart: string,
  marks: AgentDigestMark[],
  weekly?: string[],
): Promise<{ text: string; stats: Record<string, unknown> | null } | null> {
  try {
    const result = await agentApiIntegration.execute(new CreateAgentDigestRequest({ userId, kind, periodStart, marks, weekly }))
    return result.success ? { text: result.text, stats: result.stats } : null
  } catch (error) {
    if (error instanceof AgentUnavailableError) return null
    throw error
  }
}

async function makeWeekSummary(userId: string, start: string, final: boolean, now: Date) {
  const days = await checkins(userId, start, addDaysToDate(start, 6))
  if (days.length < WEEK_SUMMARY_MIN_DAYS) return fail(DiaryOperationErrorCode.NOT_ENOUGH_DAYS)
  const digest = await writeDigest(userId, 'week', start, toMarks(days))
  if (!digest) return fail(DiaryOperationErrorCode.SUMMARY_UNAVAILABLE)
  const hardDays = days.filter((d) => d.mood === 1).length
  const saved = await diaryManager.execute(
    new UpsertDiarySummaryCommand({
      userId,
      kind: 'week',
      periodStart: start,
      text: digest.text,
      stats: { ...(digest.stats ?? {}), markedDays: days.length, hardDays, final },
      generatedAt: now,
    }),
  )
  return { success: true as const, summary: saved.summary }
}

@requestHandler(CreateWeekSummaryOperation)
export class CreateWeekSummaryOperationHandler implements RequestHandler<CreateWeekSummaryOperation, Awaited<ReturnType<typeof CreateWeekSummaryOperationHandler.prototype.handle>>> {
  async handle(operation: CreateWeekSummaryOperation) {
    const { userId, weekStart: requested, now = new Date() } = operation.data
    const zone = await userZone(userId)
    if (!zone) return fail(DiaryOperationErrorCode.USER_NOT_FOUND)
    const currentWeek = weekStart(localMoment(now, zone).date)
    // Only the current week is built by hand; a finished week is closed by the scheduler.
    if (!isValidDate(requested) || requested !== currentWeek) return fail(DiaryOperationErrorCode.DATE_OUT_OF_RANGE)
    const days = await checkins(userId, currentWeek, addDaysToDate(currentWeek, 6))
    if (days.length < WEEK_SUMMARY_MIN_DAYS) return fail(DiaryOperationErrorCode.NOT_ENOUGH_DAYS)
    const existing = await diaryManager.execute(
      new ListDiarySummariesQuery({ userId, kind: 'week', from: currentWeek, to: currentWeek, limit: 1 }),
    )
    const last = existing.summaries[0]
    if (last && now.getTime() - last.generatedAt.getTime() < SUMMARY_COOLDOWN_MS) {
      return fail(DiaryOperationErrorCode.TOO_SOON)
    }
    return makeWeekSummary(userId, currentWeek, false, now)
  }
}

async function makeYearStory(userId: string, year: number, now: Date) {
  const weekly = await finalWeekSummaries(userId, year)
  if (weekly.length < YEAR_STORY_MIN_WEEKS) return fail(DiaryOperationErrorCode.NOT_ENOUGH_WEEKS)
  const previous = await yearStory(userId, year)
  if (previous && weekly.length - Number(previous.stats?.weeklyCount ?? 0) < YEAR_STORY_EXTEND_WEEKS) {
    return fail(DiaryOperationErrorCode.NOT_ENOUGH_WEEKS)
  }
  const days = await checkins(userId, `${year}-01-01`, `${year}-12-31`)
  const digest = await writeDigest(userId, 'year', `${year}-01-01`, toMarks(days), [...weekly].reverse().map((w) => w.text))
  if (!digest) return fail(DiaryOperationErrorCode.SUMMARY_UNAVAILABLE)
  const saved = await diaryManager.execute(
    new UpsertDiarySummaryCommand({
      userId,
      kind: 'year',
      periodStart: `${year}-01-01`,
      text: digest.text,
      stats: { ...(digest.stats ?? {}), weeklyCount: weekly.length, markedDays: days.length },
      generatedAt: now,
    }),
  )
  return { success: true as const, summary: saved.summary }
}

@requestHandler(CreateYearStoryOperation)
export class CreateYearStoryOperationHandler implements RequestHandler<CreateYearStoryOperation, Awaited<ReturnType<typeof CreateYearStoryOperationHandler.prototype.handle>>> {
  async handle(operation: CreateYearStoryOperation) {
    const { userId, year, now = new Date() } = operation.data
    if (!(await userZone(userId))) return fail(DiaryOperationErrorCode.USER_NOT_FOUND)
    return makeYearStory(userId, year, now)
  }
}

@requestHandler(GetDiaryEventsOperation)
export class GetDiaryEventsOperationHandler implements RequestHandler<GetDiaryEventsOperation, Awaited<ReturnType<typeof GetDiaryEventsOperationHandler.prototype.handle>>> {
  async handle(operation: GetDiaryEventsOperation) {
    const { userId } = operation.data
    if (!(await userZone(userId))) return fail(DiaryOperationErrorCode.USER_NOT_FOUND)
    // The notes themselves come from the agent's memory (`add-memory-notes`, PROTEUS-242); until it
    // serves them the block shows the empty state, or "memory is off" when the person turned it off.
    let memoryEnabled = true
    try {
      const memory = await agentApiIntegration.execute(new GetAgentMemoryRequest({ userId }))
      memoryEnabled = memory.enabled
    } catch (error) {
      if (!(error instanceof AgentUnavailableError)) throw error
    }
    return { success: true as const, memoryEnabled, events: [] as { id: string; text: string; date: string }[] }
  }
}

@requestHandler(RunWeeklyDigestsOperation)
export class RunWeeklyDigestsOperationHandler implements RequestHandler<RunWeeklyDigestsOperation, { success: true; weekly: number; yearly: number }> {
  async handle(operation: RunWeeklyDigestsOperation) {
    const { now = new Date(), limit = 20 } = operation.data
    const db = getDb()
    // People with notes in the last two weeks (a wide net: the week boundary depends on the zone).
    const since = addDaysToDate(now.toISOString().slice(0, 10), -15)
    const rows = await db
      .selectDistinct({ userId: moodCheckins.userId, timezone: users.timezone })
      .from(moodCheckins)
      .innerJoin(users, eq(users.id, moodCheckins.userId))
      .where(and(gte(moodCheckins.localDate, since), eq(users.isActive, true), eq(users.isDeleted, false)))
      .limit(500)
    let weekly = 0
    let yearly = 0
    for (const { userId, timezone } of rows) {
      if (weekly + yearly >= limit) break
      const local = localMoment(now, timezone)
      // Monday 06:00 local and later: a missed Monday is made up on the next ticks of the week.
      const mondayPassed = local.isoWeekday > 1 || local.minutes >= 6 * 60
      if (!mondayPassed) continue
      const lastWeek = addDaysToDate(weekStart(local.date), -7)
      const existing = await diaryManager.execute(
        new ListDiarySummariesQuery({ userId, kind: 'week', from: lastWeek, to: lastWeek, limit: 1 }),
      )
      if (existing.summaries[0]?.stats?.final === true) continue
      try {
        const made = await makeWeekSummary(userId, lastWeek, true, now)
        if (!made.success) continue
        weekly += 1
        const year = Number(lastWeek.slice(0, 4))
        const story = await makeYearStory(userId, year, now)
        if (story.success) yearly += 1
      } catch (error) {
        log.error('Не удалось собрать итоги недели', error)
      }
    }
    return { success: true as const, weekly, yearly }
  }
}

@requestHandler(DeleteDiaryDataOperation)
export class DeleteDiaryDataOperationHandler implements RequestHandler<DeleteDiaryDataOperation, { success: true }> {
  async handle(operation: DeleteDiaryDataOperation) {
    await diaryManager.execute(new DeleteUserDiaryCommand({ userId: operation.data.userId }))
    return { success: true as const }
  }
}

