import {
  accountDeletionProcess,
  PurgeInactiveAnonymousOperation,
} from '@ryadom/core/processes/account-deletion'
import { ANONYMOUS_RETENTION_DAYS } from '@ryadom/contracts/api/policy'

/**
 * Erases the anonymous accounts that nobody has opened for `ANONYMOUS_RETENTION_DAYS`, the promise the
 * app makes on the profile screen. Every replica runs it on its own timer, which is harmless: an
 * account is erased once, and a second replica that meets it half erased finds it gone.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** How many accounts one pass takes on: each costs a call to the agent. */
const BATCH = 50
/** A backlog (the first run after a long pause) is worked off over several passes, not forever. */
const MAX_PASSES = 10

export interface PurgeTotals {
  purged: number
  failed: number
}

export async function purgeInactiveAnonymous(now = new Date()): Promise<PurgeTotals> {
  const inactiveSince = new Date(now.getTime() - ANONYMOUS_RETENTION_DAYS * DAY_MS)
  const totals: PurgeTotals = { purged: 0, failed: 0 }
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const result = await accountDeletionProcess.execute(
      new PurgeInactiveAnonymousOperation({ inactiveSince, limit: BATCH }),
    )
    totals.purged += result.purged
    totals.failed += result.failed
    // A failure is the agent not answering: the next pass would meet the same accounts first.
    if (result.failed > 0 || result.purged < BATCH) break
  }
  return totals
}
