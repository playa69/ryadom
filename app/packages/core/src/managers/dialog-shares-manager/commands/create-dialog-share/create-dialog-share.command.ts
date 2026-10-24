import { RequestData } from 'mediatr-ts'
import type { CreateDialogShareCommandResult } from './create-dialog-share.types'

export interface CreateDialogShareCommandData {
  id: string
  userId: string
  dialogId: string
  tokenHash: string
  upToMessageId: string | null
  expiresAt: Date
  now: Date
  maxActive: number
}

export class CreateDialogShareCommand extends RequestData<CreateDialogShareCommandResult> {
  /** Survives minification: CreateDialogShareCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'CreateDialogShareCommand'

  public readonly id: string
  public readonly userId: string
  public readonly dialogId: string
  public readonly tokenHash: string
  public readonly upToMessageId: string | null
  public readonly expiresAt: Date
  public readonly now: Date
  public readonly maxActive: number

  constructor(data: CreateDialogShareCommandData) {
    super()
    this.id = data.id
    this.userId = data.userId
    this.dialogId = data.dialogId
    this.tokenHash = data.tokenHash
    this.upToMessageId = data.upToMessageId
    this.expiresAt = data.expiresAt
    this.now = data.now
    this.maxActive = data.maxActive
  }
}
