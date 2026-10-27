import { RequestData } from 'mediatr-ts'
import type { DeleteAgentDialogResult } from './delete-agent-dialog.types'

export interface DeleteAgentDialogRequestData {
  userId: string
  dialogId: string
}

/** `DELETE /v1/users/{userId}/dialogs/{dialogId}`: delete one conversation with its recap (the notes of memory stay). */
export class DeleteAgentDialogRequest extends RequestData<DeleteAgentDialogResult> {
  /** Survives build minification: DeleteAgentDialogRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteAgentDialogRequest'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: DeleteAgentDialogRequestData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
