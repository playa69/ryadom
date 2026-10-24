import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { agentApiIntegration, GetAgentDialogRequest } from '../../../integrations/agent-api'
import {
  CreateDialogShareCommand,
  CreateDialogShareCommandErrorCode,
  GetActiveDialogShareQuery,
  dialogSharesManager,
} from '../../../managers/dialog-shares-manager'
import { PROCESSES_CONFIG } from '../../config'
import { DialogAccessRefusal, ensureActiveUser } from '../../dialogs/shared/ensure-active-user'
import { toOwnedDialogShareDTO } from '../shared/dialog-share.dto'
import { isShareDisabled, shareToken, shareTokenHash } from '../shared/share-token'
import { CreateDialogShareOperation } from './create-dialog-share.operation'
import { CreateDialogShareOperationErrorCode, type CreateDialogShareResult } from './create-dialog-share.types'

const HOUR_MS = 3_600_000

/**
 * Makes the link to one conversation. The dialog must be the person's own (the agent answers by
 * `userId`), and the link shows it up to its last message at this moment. The token is not
 * stored: the id of the row is enough to compute it again.
 */
@requestHandler(CreateDialogShareOperation)
export class CreateDialogShareOperationHandler implements RequestHandler<
  CreateDialogShareOperation,
  CreateDialogShareResult
> {
  async handle(operation: CreateDialogShareOperation): Promise<CreateDialogShareResult> {
    if (isShareDisabled()) return { success: false, error: CreateDialogShareOperationErrorCode.DISABLED }
    const ttlHours = operation.ttlHours ?? PROCESSES_CONFIG.DIALOG_SHARE.DEFAULT_TTL_HOURS
    if (!(PROCESSES_CONFIG.DIALOG_SHARE.TTL_HOURS as readonly number[]).includes(ttlHours)) {
      return { success: false, error: CreateDialogShareOperationErrorCode.INVALID_TTL }
    }
    const refusal = await ensureActiveUser(operation.userId)
    if (refusal) {
      switch (refusal) {
        case DialogAccessRefusal.USER_NOT_FOUND:
          return { success: false, error: CreateDialogShareOperationErrorCode.USER_NOT_FOUND }
        case DialogAccessRefusal.USER_INACTIVE:
          return { success: false, error: CreateDialogShareOperationErrorCode.USER_INACTIVE }
        default:
          return assertNever(refusal)
      }
    }

    const dialog = await agentApiIntegration.execute(
      new GetAgentDialogRequest({ userId: operation.userId, dialogId: operation.dialogId }),
    )
    if (!dialog.success) return { success: false, error: CreateDialogShareOperationErrorCode.DIALOG_NOT_FOUND }
    // An empty conversation has nothing to show.
    const last = dialog.dialog.messages.at(-1)
    if (!last) return { success: false, error: CreateDialogShareOperationErrorCode.DIALOG_NOT_FOUND }

    const id = randomUUID()
    const now = new Date()
    const created = await dialogSharesManager.execute(
      new CreateDialogShareCommand({
        id,
        userId: operation.userId,
        dialogId: operation.dialogId,
        tokenHash: shareTokenHash(shareToken(id)),
        upToMessageId: last.id,
        expiresAt: new Date(now.getTime() + ttlHours * HOUR_MS),
        now,
        maxActive: PROCESSES_CONFIG.DIALOG_SHARE.MAX_ACTIVE_PER_USER,
      }),
    )
    if (!created.success) {
      switch (created.error) {
        case CreateDialogShareCommandErrorCode.ALREADY_EXISTS:
          return { success: false, error: CreateDialogShareOperationErrorCode.ALREADY_EXISTS }
        case CreateDialogShareCommandErrorCode.LIMIT_REACHED:
          return { success: false, error: CreateDialogShareOperationErrorCode.LIMIT_REACHED }
        default:
          return assertNever(created.error)
      }
    }
    const made = await dialogSharesManager.execute(
      new GetActiveDialogShareQuery({ userId: operation.userId, dialogId: operation.dialogId, now }),
    )
    // Just inserted, so present; the guard is for a link revoked in the same instant.
    if (!made.share) return { success: false, error: CreateDialogShareOperationErrorCode.ALREADY_EXISTS }
    return { success: true, share: toOwnedDialogShareDTO(made.share) }
  }
}
