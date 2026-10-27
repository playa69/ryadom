import type { Job, PgBoss, Queue, QueueResult, UpdateQueueOptions } from 'pg-boss'
import { AgentUnavailableError, createLogger } from '@ryadom/core/shared'
import type { JobData, JobQueueName } from '@ryadom/core/services/job-queue-service'
import { QUEUE_CATALOG, type QueueDefinition } from './catalog'

/**
 * Creates the queues of the catalog, hangs the schedules on them and registers the workers
 * (`openspec/changes/add-job-queue`, design D4). Everything pg-boss-specific stays under `src/jobs` and
 * `lib/jobs.ts`: the core sees only the port of `job-queue-service`.
 */

const logger = createLogger('jobs')

/** What a job is worked off with: its data and the job itself (the attempt number, the id). */
export type JobHandler<Q extends JobQueueName> = (data: JobData[Q], job: Job<JobData[Q]>) => Promise<void>

/** The work of each queue; the receiver of dead jobs has none. */
export type JobHandlers = { [Q in JobQueueName]?: JobHandler<Q> }

type Wanted = QueueDefinition['options']

/**
 * The fields `ensureQueues` keeps equal to the database, as the database holds them. A field that comes back empty
 * counts as unset, which differs from any value the catalog states, so an update fills it in.
 */
function heldBy(queue: QueueResult): { [K in keyof Omit<Wanted, 'policy'>]: unknown } {
  return {
    expireInSeconds: queue.expireInSeconds,
    retentionSeconds: queue.retentionSeconds,
    deleteAfterSeconds: queue.deleteAfterSeconds,
    retryLimit: queue.retryLimit,
    retryDelay: queue.retryDelay,
    retryBackoff: queue.retryBackoff,
    retryDelayMax: queue.retryDelayMax ?? null,
    heartbeatSeconds: queue.heartbeatSeconds ?? null,
    deadLetter: queue.deadLetter || null,
  }
}

/** What differs between the database and the catalog, in the shape `updateQueue` takes; null when nothing does. */
export function queueDrift(held: QueueResult, wanted: Wanted): UpdateQueueOptions | null {
  if (held.policy !== wanted.policy) {
    // pg-boss does not change a policy after creation (design D10): the queue is replaced by a new one under a new name.
    throw new Error(`Queue ${held.name} has the policy ${held.policy}, the catalog wants ${wanted.policy}`)
  }
  const current = heldBy(held)
  const { policy: _policy, ...target } = wanted
  const changed = (Object.keys(target) as (keyof typeof target)[]).filter(
    (key) => current[key] !== target[key],
  )
  if (changed.length === 0) return null
  return Object.fromEntries(changed.map((key) => [key, target[key]])) as UpdateQueueOptions
}

/**
 * Creates every queue that is missing and brings the options of the rest to the catalog. `createQueue` leaves an
 * existing queue alone, so a changed option goes through `updateQueue`. Safe to run on every replica at once.
 */
export async function ensureQueues(
  boss: PgBoss,
  catalog: readonly QueueDefinition[] = QUEUE_CATALOG,
): Promise<void> {
  for (const definition of catalog) {
    const { policy, ...rest } = definition.options
    // pg-boss reads `null` as "set to nothing" in an update and not as an option in a creation.
    const creation: Omit<Queue, 'name'> = {
      policy,
      expireInSeconds: rest.expireInSeconds,
      retentionSeconds: rest.retentionSeconds,
      deleteAfterSeconds: rest.deleteAfterSeconds,
      retryLimit: rest.retryLimit,
      retryDelay: rest.retryDelay,
      retryBackoff: rest.retryBackoff,
      ...(rest.retryDelayMax !== null ? { retryDelayMax: rest.retryDelayMax } : {}),
      ...(rest.heartbeatSeconds !== null ? { heartbeatSeconds: rest.heartbeatSeconds } : {}),
      ...(rest.deadLetter !== null ? { deadLetter: rest.deadLetter } : {}),
    }
    await boss.createQueue(definition.name, creation)
    const held = await boss.getQueue(definition.name)
    if (!held) throw new Error(`Queue ${definition.name} was not created`)
    const drift = queueDrift(held, definition.options)
    if (drift) {
      await boss.updateQueue(definition.name, drift)
      logger.info('Параметры очереди приведены к каталогу', {
        queue: definition.name,
        changed: Object.keys(drift),
      })
    }
  }
}

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
 * retries by the queue's options or, when they ran out, copies the job to `jobs.dead-letter`.
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
      { batchSize: 1, pollingIntervalSeconds: settings.pollingIntervalSeconds ?? 2 },
      async (jobs) => {
        for (const job of jobs) await runJob(definition.name, handler, job)
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
  job: Job<JobData[JobQueueName]>,
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
