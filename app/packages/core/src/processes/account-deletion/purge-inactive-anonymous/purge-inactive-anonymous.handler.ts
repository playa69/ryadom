import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import {
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  ListInactiveAnonymousUsersQuery,
  usersManager,
} from '../../../managers/users-manager'
import { eraseAccount, EraseAccountRefusal } from '../shared/erase-account'
import { PROCESSES_CONFIG } from '../../config'
import { PurgeInactiveAnonymousOperation } from './purge-inactive-anonymous.operation'
import type { PurgeInactiveAnonymousResult } from './purge-inactive-anonymous.types'

/**
 * Erases anonymous accounts that nobody has opened for the whole retention period. Without an
 * address the account cannot be reached from anywhere but the device that made it, so one that
 * has gone quiet is a phone that was lost, wiped or traded in, and what it holds is still personal
 * data that has no reason to be kept.
 *
 * It erases what "erase everything" erases at the person's request (`eraseAccount`,
 * `../shared/erase-account.ts`, the same steps in the same order): the agent erases its copy first, and
 * only then is the account anonymized. If the agent does not answer, the account is left for the next run, because
 * data cannot be declared erased while the agent still holds it. One failure does not stop the others.
 */
@requestHandler(PurgeInactiveAnonymousOperation)
export class PurgeInactiveAnonymousOperationHandler implements RequestHandler<
  PurgeInactiveAnonymousOperation,
  PurgeInactiveAnonymousResult
> {
  async handle(operation: PurgeInactiveAnonymousOperation): Promise<PurgeInactiveAnonymousResult> {
    const logger = createLogger('account-deletion')
    const { users } = await usersManager.execute(
      new ListInactiveAnonymousUsersQuery({ inactiveSince: operation.inactiveSince, limit: operation.limit }),
    )

    let purged = 0
    let failed = 0
    for (const candidate of users) {
      try {
        if (await this.purge(candidate.id, operation.inactiveSince)) purged += 1
      } catch (error) {
        failed += 1
        logger.warn('Inactive anonymous account was not erased: it stays for the next run', error, {
          userId: candidate.id,
        })
      }
    }
    if (purged > 0 || failed > 0) logger.info('Inactive anonymous accounts purged', { purged, failed })
    return { success: true, purged, failed }
  }

  /** false when the account no longer qualifies: it came back, or was deleted meanwhile. */
  private async purge(userId: string, inactiveSince: Date): Promise<boolean> {
    // Read again: the list may be a few moments old, and a person who came back in between keeps
    // their account. The agent's copy is erased only after this look.
    const found = await usersManager.execute(new GetUserByIdQuery({ userId }))
    if (!found.success) {
      switch (found.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return false
        default:
          return assertNever(found.error)
      }
    }
    const user = found.user
    if (user.isDeleted || user.isEmailConfirmed || user.lastActiveAt >= inactiveSince) return false

    const refusal = await eraseAccount(user, { reason: PROCESSES_CONFIG.DELETION.REASON_INACTIVITY })
    if (refusal) {
      switch (refusal) {
        // Gone or erased by someone else meanwhile: nothing left for this run to do.
        case EraseAccountRefusal.USER_NOT_FOUND:
        case EraseAccountRefusal.ALREADY_DELETED:
          return false
        default:
          return assertNever(refusal)
      }
    }
    createLogger('account-deletion').info('Inactive anonymous account erased', { userId })
    return true
  }
}
