import type { PgBoss } from 'pg-boss'
import { createLogger } from '@ryadom/core/shared'
import { JobQueue } from '@ryadom/core/services/job-queue-service'
import { QUEUE_CATALOG } from '@ryadom/db/jobs'
import type { JobHandler } from './registry'

const logger = createLogger('jobs')

/** A job that is ready and has not been taken for this long means nobody works the queue off. */
export const WATCHDOG_MAX_WAIT_SECONDS = 600
/** The most waiting jobs of one queue the watchdog looks at: the queues are small, and a count above this is a count enough. */
const LOOK_AT = 1000

/**
 * Every five minutes, one run for all replicas. Reports to the log, as a `warn` with the name of the queue and numbers,
 * a queue in trouble:
 *  - `jobs.dead-letter` holds jobs: the retries of an event's job (an erasure, the reset after a deleted dialog) ran
 *    out, and a person has to look (the line of that job carries what to look for);
 *  - the oldest job that is ready to run in any other queue has waited more than ten minutes: no replica works it.
 *
 * There are no Prometheus metrics in the API, so the log is where this goes (Loki reads it). The data of a job is never
 * written here: it holds identifiers of people, and the line only needs the queue and the counts (design D5, D9).
 * The watchdog reads the waiting jobs themselves rather than the counters of the queue: those are refreshed by the
 * supervision of the library once a minute and are empty on a process that does not supervise.
 */
export function watchdogJob(
  boss: Pick<PgBoss, 'findJobs'>,
  now: () => Date = () => new Date(),
): JobHandler<typeof JobQueue.JobsWatchdog> {
  return async () => {
    const nowMs = now().getTime()
    for (const { name } of QUEUE_CATALOG) {
      const waiting = await boss.findJobs(name, { queued: true, limit: LOOK_AT })
      if (name === JobQueue.JobsDeadLetter) {
        if (waiting.length > 0) {
          logger.warn('В очереди недоставленных задач есть задачи', undefined, {
            queue: name,
            count: waiting.length,
          })
        }
        continue
      }
      // A job waits from the moment it may start, not from the moment it was queued: a deferred one is not late.
      const waits = waiting
        .filter((job) => job.startAfter.getTime() <= nowMs)
        .map((job) => (nowMs - job.startAfter.getTime()) / 1000)
      const oldest = Math.max(0, ...waits)
      if (oldest > WATCHDOG_MAX_WAIT_SECONDS) {
        logger.warn('Задача ждёт исполнителя дольше положенного', undefined, {
          queue: name,
          ready: waits.length,
          oldestWaitSeconds: Math.round(oldest),
        })
      }
    }
  }
}
