import type { Sessions } from '../lib/sessions'
import type { JobHandler } from './registry'
import type { JobQueue } from '@ryadom/core/services/job-queue-service'

/**
 * Hourly. Refresh tokens that expired long ago are of no use even for spotting a replay, and subscriptions to
 * notifications of sessions that ended are never sent to. The tables only grow by the sessions of the day, and the
 * work is idempotent `DELETE`s, so a repeat is harmless.
 */
export function purgeSessionsJob(
  sessions: Pick<Sessions, 'purgeExpired'>,
): JobHandler<typeof JobQueue.SessionsPurgeExpired> {
  return async () => {
    await sessions.purgeExpired()
  }
}
