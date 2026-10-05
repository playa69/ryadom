import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ResetPasswordResult } from './reset-password.types'

export interface ResetPasswordOperationData {
  email: string
  code: string
  newPassword: string
}

/** A new password from a code in an email, not from a link. */
export class ResetPasswordOperation extends RequestData<ResetPasswordResult> {
  /** Survives minification: ResetPasswordOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ResetPasswordOperation'

  @hasPII()
  public readonly email: string

  @hasPII(true)
  public readonly code: string

  @hasPII(true)
  public readonly newPassword: string

  constructor(data: ResetPasswordOperationData) {
    super()
    this.email = data.email
    this.code = data.code
    this.newPassword = data.newPassword
  }
}
