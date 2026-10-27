import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { getJobQueueTransport } from '../config'
import { EnqueueJobRequest } from './enqueue-job.request'
import type { EnqueueJobRequestResult } from './enqueue-job.types'

/**
 * Hands the job to the transport. The caller is inside the transaction of its scenario when the action and the job
 * must stand or fall together: the real transport writes through the transaction of the current async context.
 */
@requestHandler(EnqueueJobRequest)
export class EnqueueJobRequestHandler implements RequestHandler<EnqueueJobRequest, EnqueueJobRequestResult> {
  async handle(request: EnqueueJobRequest): Promise<EnqueueJobRequestResult> {
    const jobId = await getJobQueueTransport().send({
      queue: request.queue,
      data: request.data,
      ...(request.startAfterSeconds !== undefined ? { startAfterSeconds: request.startAfterSeconds } : {}),
      ...(request.singletonKey !== undefined ? { singletonKey: request.singletonKey } : {}),
    })
    return { success: true, jobId }
  }
}
