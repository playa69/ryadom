import type { Queue } from 'pg-boss'
import { JobQueue, type JobQueueName } from '@ryadom/core/services/job-queue-service'

/**
 * The catalog of the queues (`openspec/changes/archive/2026-10-27-add-job-queue`, design D4): how each is created in the database,
 * and which of them fires on a schedule. Every option is stated, none is left to the library's default, so that
 * `ensureQueues` can compare what the database holds with what the code wants and bring the two together.
 *
 * The retries and the waits are starting values and may change without a new change. The policy of a queue cannot:
 * pg-boss does not alter it after the queue exists, a different policy means a new queue (design D10).
 */

const HOUR = 3600
const DAY = 24 * HOUR

/** The options of a queue that `ensureQueues` keeps equal to the database. */
type CatalogOptions = Required<
  Pick<
    Queue,
    | 'policy'
    | 'expireInSeconds'
    | 'retentionSeconds'
    | 'deleteAfterSeconds'
    | 'retryLimit'
    | 'retryDelay'
    | 'retryBackoff'
  >
> & {
  /** Seconds, or null when the queue has no ceiling / no heartbeat. */
  retryDelayMax: number | null
  heartbeatSeconds: number | null
  /** The queue that receives a copy of a job whose retries ran out. */
  deadLetter: JobQueueName | null
}

export interface QueueDefinition {
  name: JobQueueName
  options: CatalogOptions
  /** A cron expression (UTC): the queue fires on it, one job per firing on all replicas together. */
  cron?: string
}

/** A finished job stays a day: its data holds identifiers only, but there is no reason to keep it longer. */
const KEEP_FINISHED = DAY

/** The erasure in analytics is tried 1 + 8 times, the pause growing from a minute to an hour. */
export const ERASE_PERSON_RETRY_LIMIT = 8

/** A job of a schedule: the next firing does the same work from the state, so a failure is not retried. */
const NO_RETRY = { retryLimit: 0, retryDelay: 0, retryBackoff: false, retryDelayMax: null } as const

export const QUEUE_CATALOG: readonly QueueDefinition[] = [
  {
    // The receiver of the others comes first: a queue names its dead letter queue at creation.
    name: JobQueue.JobsDeadLetter,
    options: {
      policy: 'standard',
      expireInSeconds: 900,
      // Nobody works it off, so the jobs wait here; this is how long a copy stays for a person to see.
      retentionSeconds: 30 * DAY,
      deleteAfterSeconds: 30 * DAY,
      ...NO_RETRY,
      heartbeatSeconds: null,
      deadLetter: null,
    },
  },
  {
    name: JobQueue.SessionsPurgeExpired,
    cron: '0 * * * *',
    options: {
      policy: 'short',
      expireInSeconds: 300,
      retentionSeconds: DAY,
      deleteAfterSeconds: KEEP_FINISHED,
      ...NO_RETRY,
      heartbeatSeconds: null,
      deadLetter: JobQueue.JobsDeadLetter,
    },
  },
  {
    name: JobQueue.AccountsPurgeInactiveAnonymous,
    cron: '15 * * * *',
    options: {
      policy: 'short',
      expireInSeconds: 1800,
      retentionSeconds: DAY,
      deleteAfterSeconds: KEEP_FINISHED,
      ...NO_RETRY,
      heartbeatSeconds: 30,
      deadLetter: JobQueue.JobsDeadLetter,
    },
  },
  {
    name: JobQueue.DiaryWeeklyPass,
    cron: '* * * * *',
    options: {
      // `exclusive` replaces the in-memory flag of the old timer: while a pass runs or waits, the next is not queued.
      policy: 'exclusive',
      expireInSeconds: 600,
      retentionSeconds: DAY,
      deleteAfterSeconds: KEEP_FINISHED,
      ...NO_RETRY,
      heartbeatSeconds: 30,
      deadLetter: JobQueue.JobsDeadLetter,
    },
  },
  {
    name: JobQueue.AnalyticsErasePerson,
    options: {
      // `short` makes the key (the person) drop a second job while one waits; on `standard` a key does nothing.
      policy: 'short',
      expireInSeconds: 120,
      // A waiting job is kept two weeks: a rollout that is rolled back picks the erasures up when it returns.
      retentionSeconds: 14 * DAY,
      deleteAfterSeconds: KEEP_FINISHED,
      retryLimit: ERASE_PERSON_RETRY_LIMIT,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: HOUR,
      heartbeatSeconds: null,
      deadLetter: JobQueue.JobsDeadLetter,
    },
  },
  {
    name: JobQueue.DialogsAfterDelete,
    options: {
      policy: 'short',
      expireInSeconds: 300,
      retentionSeconds: 14 * DAY,
      deleteAfterSeconds: KEEP_FINISHED,
      retryLimit: 6,
      retryDelay: 60,
      retryBackoff: true,
      retryDelayMax: null,
      heartbeatSeconds: null,
      deadLetter: JobQueue.JobsDeadLetter,
    },
  },
  {
    name: JobQueue.JobsWatchdog,
    cron: '*/5 * * * *',
    options: {
      policy: 'exclusive',
      expireInSeconds: 120,
      retentionSeconds: DAY,
      deleteAfterSeconds: KEEP_FINISHED,
      ...NO_RETRY,
      heartbeatSeconds: null,
      deadLetter: JobQueue.JobsDeadLetter,
    },
  },
]
