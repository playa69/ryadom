import { RequestData } from 'mediatr-ts'
import type { JobQueueName } from '../jobs'
import type { CancelJobRequestResult } from './cancel-job.types'

export interface CancelJobRequestData {
  queue: JobQueueName
  jobId: string
}

export class CancelJobRequest extends RequestData<CancelJobRequestResult> {
  /** Survives minification: CancelJobRequest.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'CancelJobRequest'

  public readonly queue: JobQueueName
  public readonly jobId: string

  constructor(data: CancelJobRequestData) {
    super()
    this.queue = data.queue
    this.jobId = data.jobId
  }
}
