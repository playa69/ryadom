import type { JobWithMetadata, PgBoss } from 'pg-boss'
import { AgentUnavailableError, createLogger } from '@ryadom/core/shared'
import type { JobData, JobQueueName } from '@ryadom/core/services/job-queue-service'
import { QUEUE_CATALOG, type QueueDefinition } from '@ryadom/db/jobs'

/**
 * Hangs the schedules of the catalog on their queues and registers the workers
 * (`add-job-queue`, design D4). The catalog and the creation of the queues are shared with
 * the admin app and live in `@ryadom/db/jobs`; everything that works a queue off is here and in `lib/jobs.ts`: the core
 * sees only the port of `job-queue-service`.
 */

const logger = createLogger('jobs')

/** What a job is worked off with: its data and the job itself (the id, the attempt and the retries it may still have). */
export type JobHandler<Q extends JobQueueName> = (
  data: JobData[Q],
  job: JobWithMetadata<JobData[Q]>,
) => Promise<void>

/** The work of each queue; the receiver of dead jobs has none. */
export type JobHandlers = { [Q in JobQueueName]?: JobHandler<Q> }

/**
 * Hangs the schedules of the catalog on their queues and removes the schedules that the code no longer has (a
 * schedule row left in the database goes on creating jobs for a queue nobody works, design D10). One row per queue,
 * so the same schedule registered by every replica is one schedule.
 */
export async function registerSchedules(
  boss: PgBoss,
  catalog: readonly QueueDefinition[] = QUEUE_CATALOG,
): Promise<string[]> {
  const wanted = catalog.filter(
    (queue): queue is QueueDefinition & { cron: string } => queue.cron !== undefined,
  )
  for (const queue of wanted) {
    await boss.schedule(queue.name, queue.cron, {}, { tz: 'UTC' })
    logger.info('Расписание зарегистрировано', { queue: queue.name, cron: queue.cron })
  }
  const keep = new Set(wanted.map((queue) => queue.name))
  for (const schedule of await boss.getSchedules()) {
    if (keep.has(schedule.name as JobQueueName)) continue
    await boss.unschedule(schedule.name, schedule.key)
    logger.info('Расписание, которого нет в коде, снято', { queue: schedule.name })
  }
  return wanted.map((queue) => queue.name)
}

export interface WorkerSettings {
  /** How often a worker looks for a job, seconds (the default of pg-boss is 2). */
  pollingIntervalSeconds?: number
}

/**
 * One worker per queue that has a handler, one job at a time. A failure is logged and thrown back to pg-boss, which
 * retries by the queue's options or, when they ran out, copies the job to `jobs.dead-letter` (a queue of an event
 * names it; a schedule does not, its next firing does the work again).
 */
export async function registerWorkers(
  boss: PgBoss,
  handlers: JobHandlers,
  catalog: readonly QueueDefinition[] = QUEUE_CATALOG,
  settings: WorkerSettings = {},
): Promise<JobQueueName[]> {
  const registered: JobQueueName[] = []
  for (const definition of catalog) {
    const handler = handlers[definition.name] as JobHandler<JobQueueName> | undefined
    if (!handler) continue
    await boss.work<JobData[JobQueueName]>(
      definition.name,
      { batchSize: 1, includeMetadata: true, pollingIntervalSeconds: settings.pollingIntervalSeconds ?? 2 },
      async (jobs) => {
        // `includeMetadata` is set above; the library types a handler by the literal of the options it is given.
        for (const job of jobs as JobWithMetadata<JobData[JobQueueName]>[])
          await runJob(definition.name, handler, job)
      },
    )
    registered.push(definition.name)
    logger.info('Воркер очереди зарегистрирован', { queue: definition.name })
  }
  return registered
}

async function runJob(
  queue: JobQueueName,
  handler: JobHandler<JobQueueName>,
  job: JobWithMetadata<JobData[JobQueueName]>,
): Promise<void> {
  const started = Date.now()
  // Never the data of the job, only the facts about the run (design D9).
  const facts = () => ({
    queue,
    jobId: job.id,
    attempt: job.retryCount + 1,
    durationMs: Date.now() - started,
  })
  try {
    await handler(job.data, job)
    logger.debug('Задача выполнена', facts())
  } catch (error) {
    if (error instanceof AgentUnavailableError) {
      // The agent being down is the expected reason for a retry, not a fault of the code.
      logger.warn('Агент не ответил, задача повторится', undefined, facts())
    } else {
      logger.warn('Задача не выполнена', error, facts())
    }
    throw error
  }
}

/** Stops the workers taking new jobs; the ones that are running go on. For the first seconds of a pod's stop. */
export async function stopTakingJobs(boss: PgBoss, queues: readonly JobQueueName[]): Promise<void> {
  await Promise.allSettled(queues.map((queue) => boss.offWork(queue, { wait: false })))
}
