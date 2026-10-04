import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ResendConfirmationResult } from './resend-confirmation.types'

export interface ResendConfirmationOperationData {
  email: string
}

export class ResendConfirmationOperation extends RequestData<ResendConfirmationResult> {
  /** Survives minification: ResendConfirmationOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ResendConfirmationOperation'

  @hasPII()
  public readonly email: string

  constructor(data: ResendConfirmationOperationData) {
    super()
    this.email = data.email
  }
}
