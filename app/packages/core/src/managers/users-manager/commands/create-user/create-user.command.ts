import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { CreateUserCommandResult } from './create-user.types'

export interface CreateUserCommandData {
  userId: string
  /** Null makes an anonymous account. */
  email: string | null
  name: string | null
  isEmailConfirmed: boolean
}

export class CreateUserCommand extends RequestData<CreateUserCommandResult> {
  /** Survives minification: CreateUserCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'CreateUserCommand'

  public readonly userId: string

  @hasPII()
  public readonly email: string | null

  public readonly name: string | null
  public readonly isEmailConfirmed: boolean

  constructor(data: CreateUserCommandData) {
    super()
    this.userId = data.userId
    this.email = data.email
    this.name = data.name
    this.isEmailConfirmed = data.isEmailConfirmed
  }
}
