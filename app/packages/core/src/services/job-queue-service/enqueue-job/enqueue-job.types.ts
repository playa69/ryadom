/** `jobId` is null when a job with the same key was already waiting: the duplicate was dropped. */
export interface EnqueueJobRequestResult {
  success: true
  jobId: string | null
}
