import { RequestData } from 'mediatr-ts'
import type { RecordDialogShareViewCommandResult } from './record-dialog-share-view.types'

export interface RecordDialogShareViewCommandData {
  id: string
  now: Date
}

export class RecordDialogShareViewCommand extends RequestData<RecordDialogShareViewCommandResult> {
  /** Survives minification: RecordDialogShareViewCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'RecordDialogShareViewCommand'

  public readonly id: string
  public readonly now: Date

  constructor(data: RecordDialogShareViewCommandData) {
    super()
    this.id = data.id
    this.now = data.now
  }
}
