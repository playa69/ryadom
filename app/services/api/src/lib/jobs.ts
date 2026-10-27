import { sql } from 'drizzle-orm'
import { PgBoss, fromDrizzle, type ConstructorOptions } from 'pg-boss'
import { createLogger, getDb } from '@ryadom/core/shared'
import {
  registerJobQueueTransport,
  type JobQueueName,
  type JobQueueTransport,
} from '@ryadom/core/services/job-queue-service'
import { QUEUE_CATALOG, type QueueDefinition } from '../jobs/catalog'
import { createHandlers, type JobDeps } from '../jobs/handlers'
import {
  ensureQueues,
  registerSchedules,
  registerWorkers,
  stopTakingJobs,
  type JobHandlers,
} from '../jobs/registry'
import type { AppServerEnv } from './env'

/**
 * The job queue of the API (`openspec/changes/add-job-queue`): pg-boss in the PostgreSQL the API already has,
 * schema `pgboss`. This file builds and starts it; the queues and their work are in `src/jobs`. Everything that
 * knows pg-boss is under `src/jobs` and here: the core sees only the port of `job-queue-service` (design D3).
 *
 * The schema is installed by the migrator (`@ryadom/db`, design D2), never from here: the API starts with
 * `migrate: false`, and on a database without the schema (or with another version of it) `start()` throws and the
 * pod does not come up, which is how an unfinished rollout shows itself.
 */

const logger = createLogger('jobs')

export type JobsConfig = Pick<
  AppServerEnv,
  'DATABASE_URL' | 'JOBS_WORKERS_ENABLED' | 'JOBS_POOL_MAX' | 'JOBS_STOP_TIMEOUT_MS'
>

export interface StartJobsOptions {
  config: JobsConfig
  deps: JobDeps
  /** For tests. */
  testing?: {
    catalog?: readonly QueueDefinition[]
    /** Replaces or adds to the work of the queues. */
    handlers?: JobHandlers
    /** Does not register the transport of the core, which is one per process. */
    skipTransport?: boolean
    pollingIntervalSeconds?: number
    boss?: Partial<ConstructorOptions>
  }
}

export interface Jobs {
  boss: PgBoss
  /** The queues this process works off (empty when `JOBS_WORKERS_ENABLED` is off). */
  workers: readonly JobQueueName[]
  /** The workers stop taking new jobs; the running ones go on. First step of the stop of a pod. */
  stopTaking(): Promise<void>
  /** Waits for the running jobs for `JOBS_STOP_TIMEOUT_MS`, then closes the pool. A job that did not finish goes to another replica. */
  stop(): Promise<void>
}

/** Queues a job in the transaction of the current async context, or in the queue's own pool when there is none. */
export function createTransport(boss: PgBoss): JobQueueTransport {
  return {
    send: (job) =>
      boss.send(job.queue, job.data, {
        db: fromDrizzle(getDb(), sql),
        ...(job.startAfterSeconds !== undefined ? { startAfter: job.startAfterSeconds } : {}),
        ...(job.singletonKey !== undefined ? { singletonKey: job.singletonKey } : {}),
      }),
    cancel: async (queue, jobId) => {
      await boss.cancel(queue, jobId, { db: fromDrizzle(getDb(), sql) })
    },
  }
}

export async function startJobs(options: StartJobsOptions): Promise<Jobs> {
  const { config, deps, testing = {} } = options
  const catalog = testing.catalog ?? QUEUE_CATALOG
  const workersEnabled = config.JOBS_WORKERS_ENABLED

  const boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    max: config.JOBS_POOL_MAX,
    // See the header: the migrator installs the schema.
    migrate: false,
    // A process that does not work the queue off does not supervise it or fire its schedules either: the pod that does will.
    supervise: workersEnabled,
    schedule: workersEnabled,
    instanceName: 'api',
    ...testing.boss,
  })
  boss.on('error', (error) => logger.error('Ошибка очереди задач', error))
  boss.on('warning', (warning) => {
    // The kind and the message only: a warning of the library may carry the text of a query.
    const { type } = warning.data as { type?: string }
    logger.warn('Предупреждение очереди задач', undefined, { type, message: warning.message })
  })

  await boss.start()
  logger.info('Очередь задач запущена', { workers: workersEnabled, poolMax: config.JOBS_POOL_MAX })
  // Posting works whether or not this process works the queue off, so the queues exist either way.
  await ensureQueues(boss, catalog)
  if (!testing.skipTransport) registerJobQueueTransport(createTransport(boss))

  let workers: readonly JobQueueName[] = []
  if (workersEnabled) {
    workers = await registerWorkers(boss, { ...createHandlers(deps, boss), ...testing.handlers }, catalog, {
      pollingIntervalSeconds: testing.pollingIntervalSeconds,
    })
    await registerSchedules(boss, catalog)
  }

  return {
    boss,
    workers,
    stopTaking: () => stopTakingJobs(boss, workers),
    stop: async () => {
      await boss.stop({ graceful: true, timeout: config.JOBS_STOP_TIMEOUT_MS })
      logger.info('Очередь задач остановлена')
    },
  }
}
