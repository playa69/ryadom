import { sql } from 'drizzle-orm'
import { fromDrizzle, type DrizzleTransactionLike, type PgBoss } from 'pg-boss'

/**
 * Where the core's jobs go: the shape the core's `JobQueueTransport` asks for, written out here because the core
 * depends on this package and not the other way round (TypeScript matches the two by structure).
 */
export interface QueueTransport {
  /** The id of the new job, or null when a job with the same key was already waiting and this one was dropped. */
  send(job: {
    queue: string
    data: object
    startAfterSeconds?: number
    singletonKey?: string
  }): Promise<string | null>
  /** Cancels a job that has not started. A job that is gone or already running is not an error. */
  cancel(queue: string, jobId: string): Promise<void>
}

/**
 * Queues a job in the transaction of the caller, or in the pool of its own when there is none: `getExecutor` gives the
 * transaction of the current async context (the core's `getDb()`), and pg-boss writes through it, so a job and the
 * action that needed it are committed or rolled back together (design D3).
 */
export function createQueueTransport(
  boss: PgBoss,
  getExecutor: () => DrizzleTransactionLike,
): QueueTransport {
  return {
    send: (job) =>
      boss.send(job.queue, job.data, {
        db: fromDrizzle(getExecutor(), sql),
        ...(job.startAfterSeconds !== undefined ? { startAfter: job.startAfterSeconds } : {}),
        ...(job.singletonKey !== undefined ? { singletonKey: job.singletonKey } : {}),
      }),
    cancel: async (queue, jobId) => {
      await boss.cancel(queue, jobId, { db: fromDrizzle(getExecutor(), sql) })
    },
  }
}
