import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ForgotPasswordResult } from './forgot-password.types'

export interface ForgotPasswordOperationData {
  email: string
}

export class ForgotPasswordOperation extends RequestData<ForgotPasswordResult> {
  /** Survives minification: ForgotPasswordOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ForgotPasswordOperation'

  @hasPII()
  public readonly email: string

  constructor(data: ForgotPasswordOperationData) {
    super()
    this.email = data.email
  }
}
