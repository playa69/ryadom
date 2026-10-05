import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ConfirmUserEmailResult } from './confirm-user-email.types'

export interface ConfirmUserEmailOperationData {
  adminEmail: string
  userId: string
}

export class ConfirmUserEmailOperation extends RequestData<ConfirmUserEmailResult> {
  /** Survives minification: ConfirmUserEmailOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ConfirmUserEmailOperation'

  @hasPII()
  public readonly adminEmail: string

  public readonly userId: string

  constructor(data: ConfirmUserEmailOperationData) {
    super()
    this.adminEmail = data.adminEmail
    this.userId = data.userId
  }
}
