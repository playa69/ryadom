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
): Promise<{ text: string; stats: Record<string, unknown> | null } | null> {
  try {
    const result = await agentApiIntegration.execute(
      new CreateAgentDigestRequest({ userId, kind: 'week', periodStart, marks }),
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
  const digest = await writeDigest(userId, start, toMarks(days))
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

async function readSummary(userId: string, kind: 'week', periodStart: string): Promise<DiarySummaryDTO> {
  const { summaries } = await diaryManager.execute(
    new ListDiarySummariesQuery({ userId, kind, from: periodStart, to: periodStart, limit: 1 }),
  )
  const summary = summaries[0]
  if (!summary) throw new Error('A summary that was just written is not there')
  return summary
}
