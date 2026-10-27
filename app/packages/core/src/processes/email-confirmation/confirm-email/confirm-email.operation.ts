import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { ConfirmEmailResult } from './confirm-email.types'

export interface ConfirmEmailOperationData {
  email: string
  code: string
  /**
   * The account the request is made from, when the caller has a verified session. Omitted or null means
   * nobody is signed in, which is the safe default: a guest account's address is not confirmed for it.
   */
  callerUserId?: string | null
}

/** Email confirmation by a code from an email, not by a link. */
export class ConfirmEmailOperation extends RequestData<ConfirmEmailResult> {
  /** Survives minification: ConfirmEmailOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ConfirmEmailOperation'

  @hasPII()
  public readonly email: string

  @hasPII(true)
  public readonly code: string

  public readonly callerUserId: string | null

  constructor(data: ConfirmEmailOperationData) {
    super()
    this.email = data.email
    this.code = data.code
    this.callerUserId = data.callerUserId ?? null
  }
}
