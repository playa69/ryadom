import { randomUUID } from 'node:crypto'
import assertNever from 'assert-never'
import { inTransaction } from '../../../shared'
import {
  GetUserDeletionArchiveQuery,
  GetUserDeletionArchiveQueryErrorCode,
  SetUserDeletionArchiveCommand,
  SetUserDeletionArchiveCommandErrorCode,
  SoftDeleteUserCommand,
  SoftDeleteUserCommandErrorCode,
  usersManager,
  type UserDTO,
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
  DeleteSelfCheckResultsCommand,
  GetSelfCheckConsentQuery,
  RecordSelfCheckConsentEventCommand,
  selfCheckManager,
} from '../../../managers/self-check-manager'
import {
  GetLatestMemoryConsentEventQuery,
  RecordMemoryConsentEventCommand,
  memoryConsentEventsManager,
} from '../../../managers/memory-consent-events-manager'
import {
  EnqueueJobRequest,
  ERASE_PERSON_DELAY_SECONDS,
  JobQueue,
  jobQueueService,
} from '../../../services/job-queue-service'
import { buildDeletionArchive } from './deletion-archive'

/**
 * What an account deletion erases, in one place for every way it can happen: the person's own request
 * (`DeleteAccountOperation`), an administrator (`DeleteUserAccountOperation`) and the clean-up of guest accounts
 * nobody opened (`PurgeInactiveAnonymousOperation`). The three differ in who may ask, what they check first and the
 * reason written into the archive; what is erased does not differ, and it must not drift apart again, so the
 * steps are written once, here.
 *
 * The order: the agent erases its own copy first (conversations, memory, profile), outside the transaction and before
 * the identifier is lost; if it does not answer, `AgentUnavailableError` is thrown and the account stays whole. Then,
 * in one transaction, the archive of the personal data, the credentials, devices, links to conversations, the diary
 * (marks, week texts, widget tokens), the saved results of the self-check tests and the codes of the address are erased;
 * the row is anonymized; the consents in force are marked as withdrawn in their journals; the sessions end; and the
 * erasure of the person in product analytics is queued as the last step, so that the deletion and the job stand or
 * fall together (`add-job-queue`, D3).
 *
 * What stays: the archive (`users.properties.deletion`), the accepted consents (`user_consents`) and the journals of
 * what the person did with them (`memory_consent_events`, `self_check_consent_events`) as the evidence of consent, the
 * audit entry of an administrator.
 */

export interface EraseAccountOptions {
  /** `users.properties.deletion.reason`: who or what asked for the deletion. */
  reason: string
  /** More writes of the same transaction, after the account is anonymized and before the job is queued (the admin's audit entry). */
  alsoInTransaction?: () => Promise<void>
}

/** Why an account was not erased by this call; `null` from `eraseAccount` means it was. */
export enum EraseAccountRefusal {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  ALREADY_DELETED = 'ALREADY_DELETED',
}

export async function eraseAccount(
  user: UserDTO,
  options: EraseAccountOptions,
): Promise<EraseAccountRefusal | null> {
  const userId = user.id

  // Before the transaction and before anonymization: otherwise we lose the identifier the agent stores the
  // conversations under, and there is nothing left to erase by.
  await agentApiIntegration.execute(new EraseAgentUserRequest({ userId }))

  return inTransaction(async (): Promise<EraseAccountRefusal | null> => {
    const existing = await usersManager.execute(new GetUserDeletionArchiveQuery({ userId }))
    if (!existing.success) {
      switch (existing.error) {
        case GetUserDeletionArchiveQueryErrorCode.USER_NOT_FOUND:
          return EraseAccountRefusal.USER_NOT_FOUND
        default:
          assertNever(existing.error)
      }
    }
    if (!existing.archive) {
      const archive = await buildDeletionArchive(user, options.reason)
      const persisted = await usersManager.execute(new SetUserDeletionArchiveCommand({ userId, archive }))
      if (!persisted.success) {
        switch (persisted.error) {
          case SetUserDeletionArchiveCommandErrorCode.USER_NOT_FOUND:
            return EraseAccountRefusal.USER_NOT_FOUND
          default:
            assertNever(persisted.error)
        }
      }
    }

    // A linked address that was never confirmed has a password and a code waiting: neither is kept.
    await userCredentialsManager.execute(new DeleteUserCredentialsCommand({ userId }))
    // The account is only anonymized, so its devices must be forgotten here: otherwise they would keep signing in to it.
    await userDevicesManager.execute(new DeleteUserDevicesCommand({ userId }))
    // Links to the person's conversations die with the account (`REQ-DATA-05`).
    await dialogSharesManager.execute(new DeleteUserDialogSharesCommand({ userId }))
    // Marks, summaries and widget tokens of the diary: before the row is anonymized.
    await diaryManager.execute(new DeleteUserDiaryCommand({ userId }))
    // Saved results of the tests: gone before the deletion is announced (add-self-check-tests, D5).
    await selfCheckManager.execute(new DeleteSelfCheckResultsCommand({ userId }))
    // By email, not by userId: codes are not tied to an account. An anonymous account has none.
    if (user.email !== null)
      await emailCodesManager.execute(new DeleteEmailCodesCommand({ email: user.email }))

    const deleted = await usersManager.execute(new SoftDeleteUserCommand({ userId }))
    if (!deleted.success) {
      switch (deleted.error) {
        case SoftDeleteUserCommandErrorCode.USER_NOT_FOUND:
          return EraseAccountRefusal.USER_NOT_FOUND
        case SoftDeleteUserCommandErrorCode.ALREADY_DELETED:
          return EraseAccountRefusal.ALREADY_DELETED
        default:
          assertNever(deleted.error)
      }
    }

    // From here on only the call that anonymized the row goes on, so a second request that raced it writes nothing twice.
    await withdrawConsentsInForce(userId)
    await refreshTokensManager.execute(
      new RevokeUserRefreshTokensCommand({ userId, exceptSessionId: null, revokedAt: new Date() }),
    )
    await options.alsoInTransaction?.()
    // Last, and in the transaction: a deletion that did not complete leaves no job behind. The key keeps a second
    // request from queuing a second erasure while the first one waits.
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
}

/**
 * The consent ends with the account: a consent that was in force gets a `revoked` row in its journal, in the version
 * that was in force, so the journal shows when it ended. Memory counts as in force also while paused (a pause is not a
 * withdrawal). The journals themselves stay.
 */
async function withdrawConsentsInForce(userId: string): Promise<void> {
  const now = new Date()
  const { event } = await memoryConsentEventsManager.execute(new GetLatestMemoryConsentEventQuery({ userId }))
  if (event && event.action !== 'revoked') {
    await memoryConsentEventsManager.execute(
      new RecordMemoryConsentEventCommand({
        eventId: randomUUID(),
        userId,
        action: 'revoked',
        version: event.version,
        at: now,
      }),
    )
  }
  const selfCheck = await selfCheckManager.execute(new GetSelfCheckConsentQuery({ userId }))
  if (selfCheck.version !== null) {
    await selfCheckManager.execute(
      new RecordSelfCheckConsentEventCommand({
        id: randomUUID(),
        userId,
        action: 'revoked',
        version: selfCheck.version,
        at: now,
      }),
    )
  }
}
