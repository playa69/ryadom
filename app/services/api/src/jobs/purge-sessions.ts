import type { Sessions } from '../lib/sessions'
import type { JobHandler } from './registry'
import type { JobQueue } from '@ryadom/core/services/job-queue-service'

/**
 * Hourly. Refresh tokens that expired long ago are of no use even for spotting a replay. The table only grows by
 * the sessions of the day, and the work is an idempotent `DELETE`, so a repeat is harmless.
 */
export function purgeSessionsJob(
  sessions: Pick<Sessions, 'purgeExpired'>,
): JobHandler<typeof JobQueue.SessionsPurgeExpired> {
  return async () => {
    await sessions.purgeExpired()
  }
}
