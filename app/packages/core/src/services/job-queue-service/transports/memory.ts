import { randomUUID } from 'node:crypto'
import type { JobQueueTransport, QueuedJob } from './types'

/** A job queued through the memory transport (tests only). */
export interface EnqueuedJob extends QueuedJob {
  id: string
  enqueuedAt: Date
}

const jobs: EnqueuedJob[] = []

/**
 * Keeps the jobs in process memory. Like the real queue it drops a job whose key matches a job that is still
 * waiting. Unlike it, it knows nothing of transactions: a job stays after a rollback. What a rollback does to a job
 * is tested against the real queue (`services/api/test/jobs.test.ts`).
 */
export const memoryJobQueueTransport: JobQueueTransport = {
  async send(job) {
    const duplicate =
      job.singletonKey !== undefined &&
      jobs.some((queued) => queued.queue === job.queue && queued.singletonKey === job.singletonKey)
    if (duplicate) return null
    const id = randomUUID()
    jobs.push({ ...job, id, enqueuedAt: new Date() })
    return id
  },
  async cancel(queue, jobId) {
    const index = jobs.findIndex((queued) => queued.queue === queue && queued.id === jobId)
    if (index >= 0) jobs.splice(index, 1)
  },
}

/** A copy of the jobs the memory transport holds, in the order they were queued. */
export function getEnqueuedJobs(): EnqueuedJob[] {
  return jobs.map((job) => ({ ...job }))
}

export function clearEnqueuedJobs(): void {
  jobs.length = 0
}
