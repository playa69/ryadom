import { registerJobQueueTransport } from '@ryadom/core/services/job-queue-service'
import { createLogger, getDb } from '@ryadom/core/shared'
import { createJobProducer, ERASURE_QUEUES, type JobProducer } from '@ryadom/db/jobs'

/**
 * The admin app queues jobs and works none: an account deleted here queues the erasure of the person in product
 * analytics inside the transaction of the deletion, exactly as the API does for the person's own request, and the
 * API's workers do the erasure (`openspec/changes/archive/2026-10-27-add-job-queue`, and the unification of the erasure).
 *
 * The producer starts with the first job and creates the queues it posts to, so the admin app does not depend on the API
 * having started first, and it holds a pool of two connections. Registered at server start from `instrumentation.ts`;
 * without it the deletion would fail loudly rather than leave a profile in analytics with nobody to erase it.
 */
export function registerAdminJobQueue(env: { DATABASE_URL: string }): JobProducer {
  const logger = createLogger('admin.jobs')
  const producer = createJobProducer({
    connectionString: env.DATABASE_URL,
    getExecutor: getDb,
    queues: ERASURE_QUEUES,
    onError: (error) => logger.error('The job queue is not available to the admin app', error),
  })
  registerJobQueueTransport(producer.transport)
  return producer
}
