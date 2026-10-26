import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { DialogRecapDTO } from '../shared/dialog.dto'
import type { PutRecapResult } from './put-recap.types'

export interface PutRecapOperationData {
  userId: string
  dialogId: string
  recap: DialogRecapDTO
  source: 'manual' | 'draft'
}

/** The recap the person wrote in the journal for an ended conversation. */
export class PutRecapOperation extends RequestData<PutRecapResult> {
  /** Survives minification: PutRecapOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'PutRecapOperation'

  public readonly userId: string
  public readonly dialogId: string
  @hasPII(true)
  public readonly recap: DialogRecapDTO
  public readonly source: 'manual' | 'draft'

  constructor(data: PutRecapOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
    this.recap = data.recap
    this.source = data.source
  }
}
