import assertNever from 'assert-never'
import { dialogsProcess, ConfirmDialogDeletedOperation } from '@ryadom/core/processes/dialogs'
import {
  recomputeSummariesAfterDialogDeleted,
  RecomputeSummariesAfterDialogDeletedOperationErrorCode,
} from '@ryadom/core/processes/diary'
import { createLogger } from '@ryadom/core/shared'
import type { JobQueue } from '@ryadom/core/services/job-queue-service'
import type { JobHandler } from './registry'

const logger = createLogger('jobs')

/**
 * Two minutes after a person deleted a conversation: if the agent no longer has it, the share link is revoked and the
 * text of the conversation's week is reset (the same reset the request makes right after the deletion, so a repeat only
 * costs the week text being written once more). If the conversation is still there, the deletion did not happen and
 * there is nothing to do. An agent that does not answer makes the job throw, and the queue retries it.
 *
 * The job is queued before the agent is asked to delete, so it covers a pod that died between the agent's answer and
 * the reset (`openspec/changes/add-job-queue`, «Когда пересчитываются итоги недели»: «Сброс после удаления не удался»).
 */
export function afterDeleteJob(): JobHandler<typeof JobQueue.DialogsAfterDelete> {
  return async ({ userId, dialogId, dialogAt }) => {
    const confirmed = await dialogsProcess.execute(new ConfirmDialogDeletedOperation({ userId, dialogId }))
    if (!confirmed.deleted) {
      logger.info('Разговор на месте, сбрасывать неделю не нужно', { userId, dialogId })
      return
    }
    const reset = await recomputeSummariesAfterDialogDeleted({ userId, dialogAt: new Date(dialogAt) })
    if (!reset.success) {
      switch (reset.error) {
        case RecomputeSummariesAfterDialogDeletedOperationErrorCode.USER_NOT_FOUND:
          // The account is gone, and its diary with it.
          logger.info('Аккаунта уже нет, неделю сбрасывать не нужно', { userId, dialogId })
          return
        default:
          return assertNever(reset.error)
      }
    }
    logger.info('Неделя после удаления разговора сброшена', {
      userId,
      dialogId,
      weekDeleted: reset.weekDeleted,
    })
  }
}
