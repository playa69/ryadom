import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { getJobQueueTransport } from '../config'
import { CancelJobRequest } from './cancel-job.request'
import type { CancelJobRequestResult } from './cancel-job.types'

/** A job that is gone or already running is not an error: the caller only wants it not to start. */
@requestHandler(CancelJobRequest)
export class CancelJobRequestHandler implements RequestHandler<CancelJobRequest, CancelJobRequestResult> {
  async handle(request: CancelJobRequest): Promise<CancelJobRequestResult> {
    await getJobQueueTransport().cancel(request.queue, request.jobId)
    return { success: true }
  }
}
