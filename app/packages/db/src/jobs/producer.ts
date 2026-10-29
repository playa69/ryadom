import { PgBoss, type DrizzleTransactionLike } from 'pg-boss'
import { QUEUE_CATALOG } from './catalog'
import { catalogFor, ensureQueues } from './ensure-queues'
import { JobQueue } from './queues'
import { createQueueTransport, type QueueTransport } from './transport'

/** What a process that only queues jobs needs: its own queue and the receiver of the jobs that fail. */
export const ERASURE_QUEUES = [JobQueue.AnalyticsErasePerson] as const

export interface JobProducerOptions {
  connectionString: string
  /** The transaction of the current async context, or the pool when there is none (the core's `getDb()`). */
  getExecutor: () => DrizzleTransactionLike
  /** The queues this process posts to; they and the queues that receive their dead jobs are created on first use. */
  queues: readonly string[]
  /** Connections of the producer's own pool; it is used only to start and to create the queues. */
  poolMax?: number
  /** Called when the producer could not start: the next job tries again. */
  onError?: (error: unknown) => void
}

export interface JobProducer {
  transport: QueueTransport
  /** Closes the pool; for a process that stops, and for tests. */
  stop(): Promise<void>
}

/**
 * A producer: pg-boss that queues jobs and works none (no workers, no supervision, no schedules, no row in the
 * registry of instances). For a process that is not the API but needs to queue a job in its own transaction, the admin
 * app: an account deleted there queues the erasure of the person in analytics, and the API's workers do it.
 *
 * It starts on the first job, not with the process, and tries again on the next job if it could not: a database that
 * was down at start does not leave the process without a transport for good. It creates the queues it posts to when they
 * are missing, so it does not depend on the API having started first, and leaves the options of existing queues to the
 * API (`update: false`): the two may be a version apart during a rollout, and only the API keeps the catalog true.
 * The schema itself is installed by the migrator, never from here (`migrate: false`).
 */
export function createJobProducer(options: JobProducerOptions): JobProducer {
  let started: Promise<PgBoss> | undefined

  const start = (): Promise<PgBoss> => {
    started ??= (async () => {
      const boss = new PgBoss({
        connectionString: options.connectionString,
        max: options.poolMax ?? 2,
        migrate: false,
        supervise: false,
        schedule: false,
        registerInstance: false,
      })
      boss.on('error', (error) => options.onError?.(error))
      try {
        await boss.start()
        await ensureQueues(boss, catalogFor(options.queues, QUEUE_CATALOG), { update: false })
      } catch (error) {
        await boss.stop({ graceful: false, timeout: 1_000 }).catch(() => {})
        throw error
      }
      return boss
    })().catch((error: unknown) => {
      started = undefined
      options.onError?.(error)
      throw error
    })
    return started
  }

  // The transport needs a boss to build; it is a thin shell that starts the producer when a job arrives.
  const lazy = <T>(use: (transport: QueueTransport) => Promise<T>): Promise<T> =>
    start().then((boss) => use(createQueueTransport(boss, options.getExecutor)))

  return {
    transport: {
      send: (job) => lazy((transport) => transport.send(job)),
      cancel: (queue, jobId) => lazy((transport) => transport.cancel(queue, jobId)),
    },
    stop: async () => {
      const boss = await started?.catch(() => undefined)
      started = undefined
      await boss?.stop({ graceful: true, timeout: 5_000 })
    },
  }
}
