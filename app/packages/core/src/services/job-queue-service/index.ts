// 1. Handler imports
import './enqueue-job/enqueue-job.handler'
import './cancel-job/cancel-job.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { EnqueueJobRequest } from './enqueue-job/enqueue-job.request'
export type { EnqueueJobRequestData } from './enqueue-job/enqueue-job.request'
export { CancelJobRequest } from './cancel-job/cancel-job.request'
export type { CancelJobRequestData } from './cancel-job/cancel-job.request'

// 3. Type re-exports
export type { EnqueueJobRequestResult } from './enqueue-job/enqueue-job.types'
export type { CancelJobRequestResult } from './cancel-job/cancel-job.types'
export { registerJobQueueTransport } from './config'
export {
  AFTER_DELETE_DELAY_SECONDS,
  ERASE_PERSON_DELAY_SECONDS,
  JobQueue,
  type JobData,
  type JobQueueName,
} from './jobs'
export type { JobQueueTransport, QueuedJob } from './transports/types'
export {
  clearEnqueuedJobs,
  getEnqueuedJobs,
  memoryJobQueueTransport,
  type EnqueuedJob,
} from './transports/memory'

// 4. Union type
import type { EnqueueJobRequest } from './enqueue-job/enqueue-job.request'
import type { CancelJobRequest } from './cancel-job/cancel-job.request'

export type JobQueueServiceRequests = EnqueueJobRequest | CancelJobRequest

// 5. Facade
export class JobQueueService implements IJobQueueService {
  async execute<T extends JobQueueServiceRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: JobQueueServiceRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IJobQueueService {
  execute<T extends JobQueueServiceRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const jobQueueService: IJobQueueService = new JobQueueService()
