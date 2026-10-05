import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { LoginResult } from './login.types'

export interface LoginOperationData {
  email: string
  password: string
}

export class LoginOperation extends RequestData<LoginResult> {
  /** Survives minification: LoginOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'LoginOperation'

  @hasPII()
  public readonly email: string

  @hasPII(true)
  public readonly password: string

  constructor(data: LoginOperationData) {
    super()
    this.email = data.email
    this.password = data.password
  }
}
