import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { VerifyPasswordRequestResult } from './verify-password.types'

export interface VerifyPasswordRequestData {
  password: string
  passwordHash: string
}

export class VerifyPasswordRequest extends RequestData<VerifyPasswordRequestResult> {
  /** Survives build minification: VerifyPasswordRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'VerifyPasswordRequest'

  @hasPII(true)
  public readonly password: string

  @hasPII(true)
  public readonly passwordHash: string

  constructor(data: VerifyPasswordRequestData) {
    super()
    this.password = data.password
    this.passwordHash = data.passwordHash
  }
}
