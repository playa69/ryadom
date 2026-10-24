import { RequestData } from 'mediatr-ts'
import type { ViewSharedDialogResult } from './view-shared-dialog.types'

export interface ViewSharedDialogOperationData {
  token: string
}

export class ViewSharedDialogOperation extends RequestData<ViewSharedDialogResult> {
  /** Survives minification: ViewSharedDialogOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ViewSharedDialogOperation'

  public readonly token: string

  constructor(data: ViewSharedDialogOperationData) {
    super()
    this.token = data.token
  }
}
