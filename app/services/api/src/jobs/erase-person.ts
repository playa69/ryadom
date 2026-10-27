import assertNever from 'assert-never'
import type { ServerAnalytics } from '@ryadom/analytics/server'
import { createLogger } from '@ryadom/core/shared'
import type { JobQueue } from '@ryadom/core/services/job-queue-service'
import type { JobHandler } from './registry'

const logger = createLogger('jobs')

/**
 * Erases the person of a deleted account in product analytics. Queued in the transaction of the deletion, 30 seconds
 * ahead, so that the event batches the clients sent before it land first and cannot bring the profile back.
 *
 * At least once, so it is idempotent: asking for the erasure of a person who is already gone must not retry for ever,
 * and a retry after a lost answer must not hurt. The three outcomes of `erasePerson`:
 *  - erased: done;
 *  - not_configured: analytics erasure is off (the API said so at startup), nothing will ever succeed, so the job ends
 *    without retries;
 *  - failed: PostHog did not take the request, the job is retried by the queue's options.
 * When the retries are used up, the queue copies the job to `jobs.dead-letter`, and the error below carries the id for
 * removing the profile by hand (the only place the id is logged; the watchdog logs counts only).
 */
export function erasePersonJob(
  analytics: Pick<ServerAnalytics, 'erasePerson'>,
): JobHandler<typeof JobQueue.AnalyticsErasePerson> {
  return async ({ userId }, job) => {
    const outcome = await analytics.erasePerson(userId)
    switch (outcome) {
      case 'erased':
        logger.info('Профиль удалённого аккаунта стёрт в PostHog', { userId })
        return
      case 'not_configured':
        logger.info('Стирание в PostHog не настроено, профиль удалённого аккаунта остаётся', { userId })
        return
      case 'failed':
        if (job.retryCount >= job.retryLimit) {
          logger.error(
            'Не удалось стереть профиль удалённого аккаунта в PostHog, повторы исчерпаны: убрать вручную',
            undefined,
            { userId, attempts: job.retryCount + 1 },
          )
        }
        throw new Error('PostHog did not accept the erasure of a person')
      default:
        return assertNever(outcome)
    }
  }
}
