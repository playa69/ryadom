import { RequestData } from 'mediatr-ts'
import type { JobData, JobQueueName } from '../jobs'
import type { EnqueueJobRequestResult } from './enqueue-job.types'

export interface EnqueueJobRequestData<Q extends JobQueueName = JobQueueName> {
  queue: Q
  data: JobData[Q]
  /** Seconds to wait before the job may be taken. */
  startAfterSeconds?: number
  /** A job with this key is dropped while one with the same key is still waiting (on a queue of the `short` policy). */
  singletonKey?: string
}

export class EnqueueJobRequest<
  Q extends JobQueueName = JobQueueName,
> extends RequestData<EnqueueJobRequestResult> {
  /** Survives minification: EnqueueJobRequest.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'EnqueueJobRequest'

  public readonly queue: Q
  public readonly data: JobData[Q]
  public readonly startAfterSeconds?: number
  public readonly singletonKey?: string

  constructor(data: EnqueueJobRequestData<Q>) {
    super()
    this.queue = data.queue
    this.data = data.data
    this.startAfterSeconds = data.startAfterSeconds
    this.singletonKey = data.singletonKey
  }
}
