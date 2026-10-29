import type { JobQueueTransport } from './transports/types'

/**
 * The transport lives on globalThis rather than in the module: in Next.js the instrumentation that registers it at
 * start and the server actions that queue a job can end up with different copies of the core modules (the logger's
 * settings do the same, see `shared/logger.ts`).
 */
const TRANSPORT = Symbol.for('ryadom.jobQueue.transport')
type TransportHolder = { [TRANSPORT]?: JobQueueTransport }

/**
 * Registers the transport at startup, once per process. The API registers the queue it works off; the admin app
 * registers a producer that only queues. A process that registers none cannot queue a job, and the attempt fails
 * loudly instead of losing the job.
 */
export function registerJobQueueTransport(transport: JobQueueTransport | undefined): void {
  ;(globalThis as TransportHolder)[TRANSPORT] = transport
}

export function getJobQueueTransport(): JobQueueTransport {
  const registered = (globalThis as TransportHolder)[TRANSPORT]
  if (!registered) throw new Error('No job queue transport is registered in this process')
  return registered
}
