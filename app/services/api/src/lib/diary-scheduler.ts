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

export function startDiaryScheduler(logger: Logger): () => void {
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    diaryProcess
      .execute(new RunWeeklyDigestsOperation())
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
