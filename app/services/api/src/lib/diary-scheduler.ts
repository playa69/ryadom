import { AnalyticsEvent } from '@ryadom/analytics/events'
import type { ServerAnalytics } from '@ryadom/analytics/server'
import { diaryProcess, RunWeeklyDigestsOperation } from '@ryadom/core/processes/diary'
import type { Logger } from './logger'

/**
 * The diary's background work (design D9): every minute, on every replica, the finished week of
 * whoever's local clock passed Monday 06:00 gets its final summary.
 *
 * Safe on any number of replicas: a period is first taken by inserting a `pending` row in
 * `diary_summaries` (the unique key lets one replica win), and only the winner asks the agent.
 * A failure is logged and the next tick tries again; nothing here may take the API down.
 */

const MINUTE_MS = 60_000

/**
 * One pass: closes the finished weeks and reports the fact of each to analytics (never a text or a mood).
 * Exported for the test, which runs it with a recording analytics and a fixed clock.
 */
export async function runDiaryPass(
  analytics: Pick<ServerAnalytics, 'capture'>,
  now?: Date,
): Promise<{ weekly: number; yearly: number }> {
  const result = await diaryProcess.execute(new RunWeeklyDigestsOperation({ now }))
  for (const userId of result.weeklyUserIds) analytics.capture(userId, AnalyticsEvent.WeekSummaryGenerated, { trigger: 'auto' })
  for (const userId of result.yearlyUserIds) analytics.capture(userId, AnalyticsEvent.YearStoryGenerated, {})
  return { weekly: result.weekly, yearly: result.yearly }
}

export function startDiaryScheduler(logger: Logger, analytics: Pick<ServerAnalytics, 'capture'>): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    runDiaryPass(analytics)
      .then((result) => {
        if (result.weekly > 0 || result.yearly > 0) {
          logger.info({ weekly: result.weekly, yearly: result.yearly }, 'итоги недели собраны')
        }
      })
      .catch((error: unknown) => logger.warn({ err: error }, 'Не удалось собрать итоги недели'))
      .finally(() => {
        running = false
      })
  }, MINUTE_MS)
  timer.unref()
  return () => clearInterval(timer)
}
