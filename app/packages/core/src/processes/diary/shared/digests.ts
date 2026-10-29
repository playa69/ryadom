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
  ListAgentRecapsRequest,
  type AgentDigestMark,
  type AgentDigestRecap,
  type ListAgentRecapsResult,
} from '../../../integrations/agent-api'
import { addDaysToDate, AgentUnavailableError, localMoment } from '../../../shared'
import { PROCESSES_CONFIG } from '../../config'
import { userZone } from './user-zone'

/** A conversation of the week with the recap it ended in: the second input of the week text. */
export interface WeekRecap extends AgentDigestRecap {
  /** When the recap was stored: the text of the week is stale if a recap is newer than it. */
  at: Date
}

/**
 * What the week summary shares between the two scenarios that make it: the button and the scheduler's
 * Monday pass. Each scenario maps these failures to its own codes.
 */

export enum DigestFailureCode {
  NOT_ENOUGH_DAYS = 'NOT_ENOUGH_DAYS',
  SUMMARY_UNAVAILABLE = 'SUMMARY_UNAVAILABLE',
}

export type DigestResult =
  | { success: true; summary: DiarySummaryDTO }
  | { success: false; error: DigestFailureCode }

const { WEEK_SUMMARY_MIN_DAYS } = PROCESSES_CONFIG.DIARY

export async function checkinsBetween(userId: string, from: string, to: string): Promise<MoodCheckinDTO[]> {
  return (await diaryManager.execute(new ListMoodCheckinsQuery({ userId, from, to }))).checkins
}

const toMarks = (days: readonly MoodCheckinDTO[]): AgentDigestMark[] =>
  days.map((d) => ({ date: d.date, mood: d.mood, factor: d.factor }))

/** Asks the agent for a text; null when it cannot write one. A down agent is not an error of ours. */
async function writeDigest(
  userId: string,
  periodStart: string,
  marks: AgentDigestMark[],
  recaps: AgentDigestRecap[],
): Promise<{ text: string; stats: Record<string, unknown> | null } | null> {
  try {
    const result = await agentApiIntegration.execute(
      new CreateAgentDigestRequest({ userId, kind: 'week', periodStart, marks, recaps }),
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

/** When the text was last written (the claim of a rewrite moves `generatedAt`, this stays); texts without it fall back to `generatedAt`. */
export function writtenAt(summary: DiarySummaryDTO): Date {
  const at = typeof summary.stats?.writtenAt === 'string' ? Date.parse(summary.stats.writtenAt) : NaN
  return Number.isNaN(at) ? summary.generatedAt : new Date(at)
}

/** The agent answers at most this many recaps in one page; a week is read page by page. */
const RECAPS_PAGE = 50
/** A guard against a runaway cursor; the agent accepts as many recaps in one digest request (`MAX_RECAPS`). */
const RECAPS_WEEK_MAX = 100

/**
 * The recaps of the conversations that began in the week `start` (in the person's zone): the second input of the week text.
 * Newest first at the agent, so the pages are read until one reaches back before the week (a week can hold more than one page).
 * A down agent throws `AgentUnavailableError`: the caller must not write a text without recaps it could not read, or a recap that
 * arrives later would never make the text stale.
 */
export async function weekRecaps(userId: string, start: string): Promise<WeekRecap[]> {
  const zone = await userZone(userId)
  if (!zone) return []
  const end = addDaysToDate(start, 6)
  const result: WeekRecap[] = []
  let before: string | null = null
  for (;;) {
    const listed: ListAgentRecapsResult = await agentApiIntegration.execute(
      new ListAgentRecapsRequest({ userId, limit: RECAPS_PAGE, before }),
    )
    let reachedBack = false
    for (const item of listed.items) {
      const startedAt = new Date(item.startedAt)
      if (Number.isNaN(startedAt.getTime())) continue
      const date = localMoment(startedAt, zone).date
      if (date < start) {
        reachedBack = true
        continue
      }
      if (date > end) continue
      const at = item.recapAt ? new Date(item.recapAt) : startedAt
      result.push({ date, text: item.recap, at: Number.isNaN(at.getTime()) ? startedAt : at })
    }
    if (reachedBack || !listed.next || result.length >= RECAPS_WEEK_MAX) break
    before = listed.next
  }
  return result.slice(0, RECAPS_WEEK_MAX)
}

/** The moment of the latest change among the marks and recaps of the week: the version of the input a text is written from. */
export function inputsVersion(days: readonly MoodCheckinDTO[], recaps: readonly WeekRecap[] = []): Date {
  return new Date(Math.max(...days.map((d) => d.updatedAt.getTime()), ...recaps.map((r) => r.at.getTime())))
}

/**
 * A text needs rewriting when a mark was added or changed after the marks it was written from (design D9).
 * Texts without the version fall back to the time they were written.
 */
export function isStale(summary: DiarySummaryDTO, days: readonly MoodCheckinDTO[], recaps: readonly WeekRecap[] = []): boolean {
  const written = typeof summary.stats?.inputsAt === 'string' ? Date.parse(summary.stats.inputsAt) : summary.generatedAt.getTime()
  return inputsVersion(days, recaps).getTime() > written
}

/** The text of the week starting `start`; `final` is true when the scheduler closes a finished week. */
export async function makeWeekSummary(
  userId: string,
  start: string,
  final: boolean,
  now: Date,
  manual = false,
  known?: readonly WeekRecap[],
): Promise<DigestResult> {
  const days = await checkinsBetween(userId, start, addDaysToDate(start, 6))
  if (days.length < WEEK_SUMMARY_MIN_DAYS) return { success: false, error: DigestFailureCode.NOT_ENOUGH_DAYS }
  let recaps: readonly WeekRecap[]
  try {
    recaps = known ?? (await weekRecaps(userId, start))
  } catch (error) {
    if (error instanceof AgentUnavailableError) return { success: false, error: DigestFailureCode.SUMMARY_UNAVAILABLE }
    throw error
  }
  const digest = await writeDigest(
    userId,
    start,
    toMarks(days),
    recaps.map(({ date, text }) => ({ date, text })),
  )
  if (!digest) return { success: false, error: DigestFailureCode.SUMMARY_UNAVAILABLE }
  const hardDays = days.filter((d) => d.mood === 1).length
  await diaryManager.execute(
    new UpsertDiarySummaryCommand({
      userId,
      kind: 'week',
      periodStart: start,
      text: digest.text,
      stats: { ...(digest.stats ?? {}), markedDays: days.length, hardDays, final, inputsAt: inputsVersion(days, recaps).toISOString(), recapsCount: recaps.length, writtenAt: now.toISOString(), ...(manual ? { manualAt: now.toISOString() } : {}) },
      generatedAt: now,
    }),
  )
  return { success: true, summary: await readSummary(userId, 'week', start) }
}

async function readSummary(userId: string, kind: 'week', periodStart: string): Promise<DiarySummaryDTO> {
  const { summaries } = await diaryManager.execute(
    new ListDiarySummariesQuery({ userId, kind, from: periodStart, to: periodStart, limit: 1 }),
  )
  const summary = summaries[0]
  if (!summary) throw new Error('A summary that was just written is not there')
  return summary
}
