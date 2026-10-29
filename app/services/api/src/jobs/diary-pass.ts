import type { ServerAnalytics } from '@ryadom/analytics/server'
import { createLogger } from '@ryadom/core/shared'
import type { JobQueue } from '@ryadom/core/services/job-queue-service'
import { runDiaryPass } from '../lib/diary-scheduler'
import type { JobHandler } from './registry'

const logger = createLogger('jobs')

/**
 * Every minute, one pass for all replicas, and a new one is not queued while the last is running or waiting (the
 * `exclusive` policy of the queue). The week in progress gets its text once 3 days are marked and a new one after
 * its marks change; the finished week of whoever's local clock passed Monday 06:00 gets its final summary. A period
 * is first taken by a `pending` row in `diary_summaries`, so two passes would not write the same week twice anyway.
 */
export function diaryPassJob(
  analytics: Pick<ServerAnalytics, 'capture'>,
): JobHandler<typeof JobQueue.DiaryWeeklyPass> {
  return async () => {
    const result = await runDiaryPass(analytics)
    if (result.weekly > 0) logger.info('Итоги недели собраны', { weekly: result.weekly })
  }
}
