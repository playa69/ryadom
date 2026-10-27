import type { JobQueueTransport } from './transports/types'

let registered: JobQueueTransport | undefined

/**
 * Registers the transport at startup, once per process. The API registers the real queue; a process that does
 * not (the admin app) cannot queue a job, and the attempt fails loudly instead of losing the job.
 */
export function registerJobQueueTransport(transport: JobQueueTransport | undefined): void {
  registered = transport
}

export function getJobQueueTransport(): JobQueueTransport {
  if (!registered) throw new Error('No job queue transport is registered in this process')
  return registered
}
