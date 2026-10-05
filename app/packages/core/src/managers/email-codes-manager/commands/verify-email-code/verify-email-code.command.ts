import { RequestData } from 'mediatr-ts'
import type { EmailCodePurpose } from '@ryadom/db/schema'
import { hasPII } from '../../../../shared'
import type { VerifyEmailCodeCommandResult } from './verify-email-code.types'

export interface VerifyEmailCodeCommandData {
  email: string
  purpose: EmailCodePurpose
  /** SHA-256 of the submitted code. */
  codeHash: string
}

export class VerifyEmailCodeCommand extends RequestData<VerifyEmailCodeCommandResult> {
  /** Survives minification: VerifyEmailCodeCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'VerifyEmailCodeCommand'

  @hasPII()
  public readonly email: string

  public readonly purpose: EmailCodePurpose

  @hasPII(true)
  public readonly codeHash: string

  constructor(data: VerifyEmailCodeCommandData) {
    super()
    this.email = data.email
    this.purpose = data.purpose
    this.codeHash = data.codeHash
  }
}
