import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ConfirmEmailResult } from './confirm-email.types'

export interface ConfirmEmailOperationData {
  email: string
  code: string
}

/** Email confirmation by a code from an email, not by a link. */
export class ConfirmEmailOperation extends RequestData<ConfirmEmailResult> {
  /** Survives minification: ConfirmEmailOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ConfirmEmailOperation'

  @hasPII()
  public readonly email: string

  @hasPII(true)
  public readonly code: string

  constructor(data: ConfirmEmailOperationData) {
    super()
    this.email = data.email
    this.code = data.code
  }
}
