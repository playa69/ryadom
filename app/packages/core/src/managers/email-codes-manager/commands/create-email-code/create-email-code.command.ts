import { RequestData } from 'mediatr-ts'
import type { EmailCodePurpose } from '@ryadom/db/schema'
import { hasPII } from '../../../../shared'
import type { CreateEmailCodeCommandResult } from './create-email-code.types'

export interface CreateEmailCodeCommandData {
  codeId: string
  email: string
  purpose: EmailCodePurpose
  /** SHA-256 of the code, not the code itself. */
  codeHash: string
  expiresAt: Date
}

export class CreateEmailCodeCommand extends RequestData<CreateEmailCodeCommandResult> {
  /** Survives minification: CreateEmailCodeCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'CreateEmailCodeCommand'

  public readonly codeId: string

  @hasPII()
  public readonly email: string

  public readonly purpose: EmailCodePurpose

  @hasPII(true)
  public readonly codeHash: string

  public readonly expiresAt: Date

  constructor(data: CreateEmailCodeCommandData) {
    super()
    this.codeId = data.codeId
    this.email = data.email
    this.purpose = data.purpose
    this.codeHash = data.codeHash
    this.expiresAt = data.expiresAt
  }
}
