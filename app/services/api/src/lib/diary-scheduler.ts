import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { ServerAnalytics } from '@ryadom/analytics/server'
import { diaryProcess, RunWeeklyDigestsOperation } from '@ryadom/core/processes/diary'

/**
 * The diary's background work (design D9) is the queue `diary.weekly-pass` (`src/jobs/diary-pass.ts`): every minute,
 * one pass for all replicas. The week in progress gets its text once 3 days are marked and a new one after its marks
 * change (a minute after the last tap); the finished week of whoever's local clock passed Monday 06:00 gets its final
 * summary.
 *
 * Safe on any number of replicas: a period is first taken by inserting a `pending` row in `diary_summaries` (the unique
 * key lets one replica win), and only the winner asks the agent. A failure is logged and the next pass tries again;
 * nothing here may take the API down.
 */

/**
 * One pass: writes the week texts and reports the fact of each to analytics (never a text or a mood).
 * Exported for the test, which runs it with a recording analytics and a fixed clock.
 */
export async function runDiaryPass(
  analytics: Pick<ServerAnalytics, 'capture'>,
  now?: Date,
): Promise<{ weekly: number }> {
  const result = await diaryProcess.execute(new RunWeeklyDigestsOperation({ now }))
  for (const userId of result.weeklyUserIds)
    analytics.capture(userId, AnalyticsEvent.WeekSummaryGenerated, { trigger: 'auto' })
  return { weekly: result.weekly }
}
