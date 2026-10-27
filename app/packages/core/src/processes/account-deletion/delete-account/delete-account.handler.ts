import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { createLogger, inTransaction } from '../../../shared'
import {
  GetUserByIdQuery,
  GetUserByIdQueryErrorCode,
  GetUserDeletionArchiveQuery,
  GetUserDeletionArchiveQueryErrorCode,
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
import { agentApiIntegration, EraseAgentUserRequest } from '../../../integrations/agent-api'
import {
  RevokeUserRefreshTokensCommand,
  refreshTokensManager,
} from '../../../managers/refresh-tokens-manager'
import { DeleteUserDevicesCommand, userDevicesManager } from '../../../managers/user-devices-manager'
import { DeleteUserDialogSharesCommand, dialogSharesManager } from '../../../managers/dialog-shares-manager'
import { DeleteUserDiaryCommand, diaryManager } from '../../../managers/diary-manager'
import {
  EnqueueJobRequest,
  ERASE_PERSON_DELAY_SECONDS,
  JobQueue,
  jobQueueService,
} from '../../../services/job-queue-service'
import { buildDeletionArchive } from '../shared/deletion-archive'
import { PROCESSES_CONFIG } from '../../config'
import { DeleteAccountOperation } from './delete-account.operation'
import { DeleteAccountOperationErrorCode, type DeleteAccountResult } from './delete-account.types'

/**
 * "Erase everything" at the person's request.
 *
 * The order matters: the agent erases its own copy first (transcripts, memory, profile) and
 * only then is the account deleted. If the agent does not answer, the operation throws
 * `AgentUnavailableError` and the account stays: data cannot be declared erased while the
 * agent still holds it.
 *
 * The deletion is soft: personal data is archived into `users.properties.deletion`, the
 * password and codes are deleted, and the row is anonymized. The email is freed for a new
 * registration.
 *
 * Erasing the person in product analytics is a job queued in the same transaction as the last step of the
 * deletion (`analytics.erase-person`, `openspec/changes/add-job-queue`): the account is deleted and the erasure
 * is queued, or neither happens. The job waits `ERASE_PERSON_DELAY_SECONDS` so that the batches of events the
 * clients sent before the deletion land first, and the queue keeps it through a restart of the pod. It is the
 * person's own request only: an administrator's deletion and the retention clean-up leave analytics alone.
 */
@requestHandler(DeleteAccountOperation)
export class DeleteAccountOperationHandler implements RequestHandler<DeleteAccountOperation, DeleteAccountResult> {
  async handle(operation: DeleteAccountOperation): Promise<DeleteAccountResult> {
    const userResult = await usersManager.execute(new GetUserByIdQuery({ userId: operation.userId }))
    if (!userResult.success) {
      switch (userResult.error) {
        case GetUserByIdQueryErrorCode.USER_NOT_FOUND:
          return { success: false, error: DeleteAccountOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(userResult.error)
      }
    }
    const user = userResult.user
    if (user.isDeleted) return { success: false, error: DeleteAccountOperationErrorCode.ALREADY_DELETED }
    const userId = user.id

    // Before the transaction and before anonymization: otherwise we lose the identifier the
    // agent stores the conversations under, and there is nothing left to erase by.
    await agentApiIntegration.execute(new EraseAgentUserRequest({ userId }))

    const failure = await inTransaction(async (): Promise<DeleteAccountOperationErrorCode | null> => {
      const existing = await usersManager.execute(new GetUserDeletionArchiveQuery({ userId }))
      if (!existing.success) {
        switch (existing.error) {
          case GetUserDeletionArchiveQueryErrorCode.USER_NOT_FOUND:
            return DeleteAccountOperationErrorCode.USER_NOT_FOUND
          default:
            assertNever(existing.error)
        }
      }
      if (!existing.archive) {
        const archive = await buildDeletionArchive(user, PROCESSES_CONFIG.DELETION.REASON_USER_REQUEST)
        const persisted = await usersManager.execute(new SetUserDeletionArchiveCommand({ userId, archive }))
        if (!persisted.success) {
          switch (persisted.error) {
            case SetUserDeletionArchiveCommandErrorCode.USER_NOT_FOUND:
              return DeleteAccountOperationErrorCode.USER_NOT_FOUND
            default:
              assertNever(persisted.error)
          }
        }
      }

      await userCredentialsManager.execute(new DeleteUserCredentialsCommand({ userId }))
      // The account is only anonymized, so its devices must be forgotten here: otherwise they would
      // keep signing in to it.
      await userDevicesManager.execute(new DeleteUserDevicesCommand({ userId }))
      // Links to the person's conversations die with the account (`REQ-DATA-05`).
      await dialogSharesManager.execute(new DeleteUserDialogSharesCommand({ userId }))
      // Marks, summaries and widget tokens of the diary: before the row is anonymized.
      await diaryManager.execute(new DeleteUserDiaryCommand({ userId }))
      // By email, not by userId: codes are not tied to an account. An anonymous account has none.
      if (user.email !== null)
        await emailCodesManager.execute(new DeleteEmailCodesCommand({ email: user.email }))

      const deleted = await usersManager.execute(new SoftDeleteUserCommand({ userId }))
      if (!deleted.success) {
        switch (deleted.error) {
          case SoftDeleteUserCommandErrorCode.USER_NOT_FOUND:
            return DeleteAccountOperationErrorCode.USER_NOT_FOUND
          case SoftDeleteUserCommandErrorCode.ALREADY_DELETED:
            return DeleteAccountOperationErrorCode.ALREADY_DELETED
          default:
            assertNever(deleted.error)
        }
      }
      await refreshTokensManager.execute(
        new RevokeUserRefreshTokensCommand({ userId, exceptSessionId: null, revokedAt: new Date() }),
      )
      // Last, and in the transaction: a deletion that did not complete leaves no job behind. The key keeps a
      // second request from queuing a second erasure while the first one waits.
      await jobQueueService.execute(
        new EnqueueJobRequest({
          queue: JobQueue.AnalyticsErasePerson,
          data: { userId },
          startAfterSeconds: ERASE_PERSON_DELAY_SECONDS,
          singletonKey: userId,
        }),
      )
      return null
    })
    if (failure) return { success: false, error: failure }
    createLogger('account-deletion').info('Account deleted', { userId })
    return { success: true }
  }
}
