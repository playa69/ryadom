import { RequestData } from 'mediatr-ts'

import type { DraftRecapResult } from './draft-recap.types'

export interface DraftRecapOperationData {
  userId: string
  dialogId: string
}

/** A draft recap for «Предзаполнить»; nothing is stored. */
export class DraftRecapOperation extends RequestData<DraftRecapResult> {
  /** Survives minification: DraftRecapOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'DraftRecapOperation'

  public readonly userId: string
  public readonly dialogId: string

  constructor(data: DraftRecapOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
  }
}
