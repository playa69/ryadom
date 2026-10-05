import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { RegisterResult } from './register.types'

export interface RegisterOperationData {
  email: string
  password: string
  name: string
}

export class RegisterOperation extends RequestData<RegisterResult> {
  /** Survives minification: RegisterOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'RegisterOperation'

  @hasPII()
  public readonly email: string

  @hasPII(true)
  public readonly password: string

  public readonly name: string

  constructor(data: RegisterOperationData) {
    super()
    this.email = data.email
    this.password = data.password
    this.name = data.name
  }
}
