import { createLogger } from '@ryadom/core/shared'
import type { JobQueue } from '@ryadom/core/services/job-queue-service'
import { purgeInactiveAnonymous } from '../lib/anonymous-retention'
import type { JobHandler } from './registry'

const logger = createLogger('jobs')

/**
 * Hourly, at a quarter past, one run for all replicas. Erases the anonymous accounts nobody has opened for the
 * retention period, the agent's copy included. It looks at the state and not at the history: what a run missed
 * (no replica was up) the next run finds again.
 */
export function purgeAnonymousJob(): JobHandler<typeof JobQueue.AccountsPurgeInactiveAnonymous> {
  return async () => {
    const totals = await purgeInactiveAnonymous()
    if (totals.purged > 0) logger.info('Неактивные анонимные аккаунты стёрты', { ...totals })
    // The agent did not answer for some accounts: the next hourly run meets them first.
    if (totals.failed > 0)
      logger.warn('Часть неактивных анонимных аккаунтов стереть не удалось', undefined, { ...totals })
  }
}
