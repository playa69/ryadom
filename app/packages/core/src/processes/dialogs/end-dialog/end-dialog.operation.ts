import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { EndDialogResult } from './end-dialog.types'

export interface EndDialogOperationData {
  userId: string
  dialogId: string
  /** "What are you taking with you". */
  takeaway: string | null
  tensionAfter: number | null
  /** `draft`: the takeaway, which is the recap, was pre-filled by the model. */
  recapSource?: 'manual' | 'draft'
}

export class EndDialogOperation extends RequestData<EndDialogResult> {
  /** Survives minification: EndDialogOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'EndDialogOperation'

  public readonly userId: string
  public readonly dialogId: string

  @hasPII(true)
  public readonly takeaway: string | null

  public readonly tensionAfter: number | null

  public readonly recapSource: 'manual' | 'draft'

  constructor(data: EndDialogOperationData) {
    super()
    this.userId = data.userId
    this.dialogId = data.dialogId
    this.takeaway = data.takeaway
    this.tensionAfter = data.tensionAfter
    this.recapSource = data.recapSource ?? 'manual'
  }
}
