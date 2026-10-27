export interface QueuedJob {
  queue: string
  data: object
  /** Seconds to wait before the job may be taken. */
  startAfterSeconds?: number
  /** A job with the key of one that is still waiting is dropped, not queued twice. */
  singletonKey?: string
}

/**
 * Where the jobs go. The API registers the one that writes into the job tables of its own database in the
 * transaction of the caller (`services/api/src/lib/jobs.ts`); the tests of the core use the memory one.
 */
export interface JobQueueTransport {
  /** The id of the new job, or null when a job with the same key was already waiting and this one was dropped. */
  send(job: QueuedJob): Promise<string | null>
  /** Cancels a job that has not started. A job that is gone or already running is not an error. */
  cancel(queue: string, jobId: string): Promise<void>
}
