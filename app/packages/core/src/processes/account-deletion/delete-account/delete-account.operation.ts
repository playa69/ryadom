import { RequestData } from 'mediatr-ts'
import type { DeleteAccountResult } from './delete-account.types'

export interface DeleteAccountOperationData {
  userId: string
}

export class DeleteAccountOperation extends RequestData<DeleteAccountResult> {
  /** Survives minification: DeleteAccountOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteAccountOperation'

  public readonly userId: string

  constructor(data: DeleteAccountOperationData) {
    super()
    this.userId = data.userId
  }
}
