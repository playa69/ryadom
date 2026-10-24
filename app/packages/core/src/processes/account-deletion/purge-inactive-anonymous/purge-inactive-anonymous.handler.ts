import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction } from '../../../shared'
import {
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  GetUserDeletionArchiveQuery,
  GetUserDeletionArchiveQueryErrorCode,
  ListInactiveAnonymousUsersQuery,
  SetUserDeletionArchiveCommand,
  SetUserDeletionArchiveCommandErrorCode,
  SoftDeleteUserCommand,
  SoftDeleteUserCommandErrorCode,
  usersManager,
} from '../../../managers/users-manager'
import {
  DeleteUserCredentialsCommand,
  userCredentialsManager,
} from '../../../managers/user-credentials-manager'
import { DeleteEmailCodesCommand, emailCodesManager } from '../../../managers/email-codes-manager'
import {
  RevokeUserRefreshTokensCommand,
  refreshTokensManager,
} from '../../../managers/refresh-tokens-manager'
import { DeleteUserDevicesCommand, userDevicesManager } from '../../../managers/user-devices-manager'
import { DeleteUserDialogSharesCommand, dialogSharesManager } from '../../../managers/dialog-shares-manager'
import { agentApiIntegration, EraseAgentUserRequest } from '../../../integrations/agent-api'
import { buildDeletionArchive } from '../shared/deletion-archive'
import { PROCESSES_CONFIG } from '../../config'
import { PurgeInactiveAnonymousOperation } from './purge-inactive-anonymous.operation'
import type { PurgeInactiveAnonymousResult } from './purge-inactive-anonymous.types'

/**
 * Erases anonymous accounts that nobody has opened for the whole retention period. Without an
 * address the account cannot be reached from anywhere but the device that made it, so one that
 * has gone quiet is a phone that was lost, wiped or traded in, and what it holds is still personal
 * data that has no reason to be kept.
 *
 * It does what "erase everything" does at the person's request, in the same order: the agent
 * erases its copy first, and only then is the account anonymized. If the agent does not answer,
 * the account is left for the next run, because data cannot be declared erased while the agent still
 * holds it. One failure does not stop the others.
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

    await agentApiIntegration.execute(new EraseAgentUserRequest({ userId }))

    const outcome = await inTransaction(async (): Promise<boolean> => {
      const existing = await usersManager.execute(new GetUserDeletionArchiveQuery({ userId }))
      if (!existing.success) {
        switch (existing.error) {
          case GetUserDeletionArchiveQueryErrorCode.USER_NOT_FOUND:
            return false
          default:
            return assertNever(existing.error)
        }
      }
      if (!existing.archive) {
        const archive = await buildDeletionArchive(user, PROCESSES_CONFIG.DELETION.REASON_INACTIVITY)
        const persisted = await usersManager.execute(new SetUserDeletionArchiveCommand({ userId, archive }))
        if (!persisted.success) {
          switch (persisted.error) {
            case SetUserDeletionArchiveCommandErrorCode.USER_NOT_FOUND:
              return false
            default:
              return assertNever(persisted.error)
          }
        }
      }

      // A linked address that was never confirmed has a password and a code waiting: neither is kept.
      await userCredentialsManager.execute(new DeleteUserCredentialsCommand({ userId }))
      await userDevicesManager.execute(new DeleteUserDevicesCommand({ userId }))
      // Links to the person's conversations die with the account (`REQ-DATA-05`).
      await dialogSharesManager.execute(new DeleteUserDialogSharesCommand({ userId }))
      if (user.email !== null)
        await emailCodesManager.execute(new DeleteEmailCodesCommand({ email: user.email }))

      const deleted = await usersManager.execute(new SoftDeleteUserCommand({ userId }))
      if (!deleted.success) {
        switch (deleted.error) {
          case SoftDeleteUserCommandErrorCode.USER_NOT_FOUND:
          case SoftDeleteUserCommandErrorCode.ALREADY_DELETED:
            return false
          default:
            return assertNever(deleted.error)
        }
      }
      await refreshTokensManager.execute(
        new RevokeUserRefreshTokensCommand({ userId, exceptSessionId: null, revokedAt: new Date() }),
      )
      return true
    })
    if (outcome) createLogger('account-deletion').info('Inactive anonymous account erased', { userId })
    return outcome
  }
}
