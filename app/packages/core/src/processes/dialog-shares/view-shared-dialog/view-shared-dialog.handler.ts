import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { agentApiIntegration, GetAgentDialogRequest } from '../../../integrations/agent-api'
import {
  FindDialogShareByTokenQuery,
  RecordDialogShareViewCommand,
  dialogSharesManager,
} from '../../../managers/dialog-shares-manager'
import { ensureActiveUser } from '../../dialogs/shared/ensure-active-user'
import { toDialogDTO } from '../../dialogs/shared/dialog.dto'
import { shareTokenHash } from '../shared/share-token'
import { ViewSharedDialogOperation } from './view-shared-dialog.operation'
import { ViewSharedDialogOperationErrorCode, type ViewSharedDialogResult } from './view-shared-dialog.types'

const NOT_FOUND = { success: false, error: ViewSharedDialogOperationErrorCode.NOT_FOUND } as const

/**
 * What a link opens. Every reason not to show anything is the same answer: the link is gone, never
 * "expired" or "revoked". The texts are read from the agent now, so a dialog the person deleted or
 * forgot is gone from here too; the owner's account must still be live. Only roles, texts and times
 * leave: no summary, no tension, no identifiers.
 */
@requestHandler(ViewSharedDialogOperation)
export class ViewSharedDialogOperationHandler implements RequestHandler<
  ViewSharedDialogOperation,
  ViewSharedDialogResult
> {
  async handle(operation: ViewSharedDialogOperation): Promise<ViewSharedDialogResult> {
    const found = await dialogSharesManager.execute(
      new FindDialogShareByTokenQuery({ tokenHash: shareTokenHash(operation.token), now: new Date() }),
    )
    const share = found.share
    if (!share) return NOT_FOUND
    if (await ensureActiveUser(share.userId)) return NOT_FOUND

    // AgentUnavailableError is left to propagate: "try later" is not "the link is gone".
    const result = await agentApiIntegration.execute(
      new GetAgentDialogRequest({ userId: share.userId, dialogId: share.dialogId }),
    )
    if (!result.success) return NOT_FOUND
    const dialog = toDialogDTO(result.dialog)
    const cut = share.upToMessageId === null ? -1 : dialog.messages.findIndex((m) => m.id === share.upToMessageId)
    // The boundary message is gone (the dialog was changed under it): show nothing rather than everything.
    if (cut < 0) return NOT_FOUND
    const messages = dialog.messages.slice(0, cut + 1)

    await dialogSharesManager.execute(new RecordDialogShareViewCommand({ id: share.id, now: new Date() }))
    return {
      success: true,
      dialog: {
        startedAt: dialog.startedAt,
        sharedAt: share.createdAt,
        expiresAt: share.expiresAt,
        // Still going when it was shared: it has not ended, or it ended only after the link was made.
        isOpen: dialog.endedAt === null || dialog.endedAt > share.createdAt,
        messages: messages.map(({ role, text, createdAt }) => ({ role, text, createdAt })),
      },
    }
  }
}
