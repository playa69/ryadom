import assertNever from 'assert-never'
import {
  diaryManager,
  ListDiarySummariesQuery,
  ListMoodCheckinsQuery,
  UpsertDiarySummaryCommand,
  type DiarySummaryDTO,
  type MoodCheckinDTO,
} from '../../../managers/diary-manager'
import {
  agentApiIntegration,
  CreateAgentDigestRequest,
  CreateAgentDigestRequestErrorCode,
  type AgentDigestMark,
} from '../../../integrations/agent-api'
import { addDaysToDate, AgentUnavailableError } from '../../../shared'
import { PROCESSES_CONFIG } from '../../config'

/**
 * What the week and year summaries share, for the three scenarios that make them: the button, the
 * year story button and the scheduler's Monday pass. Each scenario maps these failures to its own codes.
 */

export enum DigestFailureCode {
  NOT_ENOUGH_DAYS = 'NOT_ENOUGH_DAYS',
  NOT_ENOUGH_WEEKS = 'NOT_ENOUGH_WEEKS',
  SUMMARY_UNAVAILABLE = 'SUMMARY_UNAVAILABLE',
}

export type DigestResult =
  | { success: true; summary: DiarySummaryDTO }
  | { success: false; error: DigestFailureCode }

const { WEEK_SUMMARY_MIN_DAYS, YEAR_STORY_MIN_WEEKS, YEAR_STORY_EXTEND_WEEKS } = PROCESSES_CONFIG.DIARY

export async function checkinsBetween(userId: string, from: string, to: string): Promise<MoodCheckinDTO[]> {
  return (await diaryManager.execute(new ListMoodCheckinsQuery({ userId, from, to }))).checkins
}

const toMarks = (days: readonly MoodCheckinDTO[]): AgentDigestMark[] =>
  days.map((d) => ({ date: d.date, mood: d.mood, factor: d.factor }))

/** Final week summaries (closed by the scheduler) of a calendar year, newest first. */
export async function finalWeekSummaries(userId: string, year: number): Promise<DiarySummaryDTO[]> {
  const { summaries } = await diaryManager.execute(
    new ListDiarySummariesQuery({ userId, kind: 'week', from: `${year}-01-01`, to: `${year}-12-31`, limit: 60 }),
  )
  return summaries.filter((s) => s.stats?.final === true)
}

export async function yearStoryOf(userId: string, year: number): Promise<DiarySummaryDTO | null> {
  const { summaries } = await diaryManager.execute(
    new ListDiarySummariesQuery({ userId, kind: 'year', from: `${year}-01-01`, to: `${year}-01-01`, limit: 1 }),
  )
  return summaries[0] ?? null
}

/** Asks the agent for a text; null when it cannot write one. A down agent is not an error of ours. */
async function writeDigest(
  userId: string,
  kind: 'week' | 'year',
  periodStart: string,
  marks: AgentDigestMark[],
  weekly?: string[],
): Promise<{ text: string; stats: Record<string, unknown> | null } | null> {
  try {
    const result = await agentApiIntegration.execute(
      new CreateAgentDigestRequest({ userId, kind, periodStart, marks, weekly }),
    )
    if (!result.success) {
      switch (result.error) {
        case CreateAgentDigestRequestErrorCode.UNAVAILABLE:
          return null
        default:
          return assertNever(result.error)
      }
    }
    return { text: result.text, stats: result.stats }
  } catch (error) {
    if (error instanceof AgentUnavailableError) return null
    throw error
  }
}

/** The text of the week starting `start`; `final` is true when the scheduler closes a finished week. */
export async function makeWeekSummary(userId: string, start: string, final: boolean, now: Date): Promise<DigestResult> {
  const days = await checkinsBetween(userId, start, addDaysToDate(start, 6))
  if (days.length < WEEK_SUMMARY_MIN_DAYS) return { success: false, error: DigestFailureCode.NOT_ENOUGH_DAYS }
  const digest = await writeDigest(userId, 'week', start, toMarks(days))
  if (!digest) return { success: false, error: DigestFailureCode.SUMMARY_UNAVAILABLE }
  const hardDays = days.filter((d) => d.mood === 1).length
  await diaryManager.execute(
    new UpsertDiarySummaryCommand({
      userId,
      kind: 'week',
      periodStart: start,
      text: digest.text,
      stats: { ...(digest.stats ?? {}), markedDays: days.length, hardDays, final },
      generatedAt: now,
    }),
  )
  return { success: true, summary: await readSummary(userId, 'week', start) }
}

/**
 * The year story of `year`. `force` is the rebuild after a conversation was deleted: the story was removed on purpose,
 * so the «add more» rule (four new weeks since the last text) does not apply.
 */
export async function makeYearStory(userId: string, year: number, now: Date, force = false): Promise<DigestResult> {
  const weekly = await finalWeekSummaries(userId, year)
  if (weekly.length < YEAR_STORY_MIN_WEEKS) return { success: false, error: DigestFailureCode.NOT_ENOUGH_WEEKS }
  const previous = await yearStoryOf(userId, year)
  if (!force && previous && weekly.length - Number(previous.stats?.weeklyCount ?? 0) < YEAR_STORY_EXTEND_WEEKS) {
    return { success: false, error: DigestFailureCode.NOT_ENOUGH_WEEKS }
  }
  const days = await checkinsBetween(userId, `${year}-01-01`, `${year}-12-31`)
  const digest = await writeDigest(userId, 'year', `${year}-01-01`, toMarks(days), [...weekly].reverse().map((w) => w.text))
  if (!digest) return { success: false, error: DigestFailureCode.SUMMARY_UNAVAILABLE }
  await diaryManager.execute(
    new UpsertDiarySummaryCommand({
      userId,
      kind: 'year',
      periodStart: `${year}-01-01`,
      text: digest.text,
      stats: { ...(digest.stats ?? {}), weeklyCount: weekly.length, markedDays: days.length },
      generatedAt: now,
    }),
  )
  return { success: true, summary: await readSummary(userId, 'year', `${year}-01-01`) }
}

async function readSummary(userId: string, kind: 'week' | 'year', periodStart: string): Promise<DiarySummaryDTO> {
  const { summaries } = await diaryManager.execute(
    new ListDiarySummariesQuery({ userId, kind, from: periodStart, to: periodStart, limit: 1 }),
  )
  const summary = summaries[0]
  if (!summary) throw new Error('A summary that was just written is not there')
  return summary
}
