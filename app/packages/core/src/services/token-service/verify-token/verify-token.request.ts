import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { VerifyTokenRequestResult } from './verify-token.types'

export interface VerifyTokenRequestData {
  token: string
  /** What `HashTokenRequest` made of the token when it was issued. */
  tokenHash: string
}

export class VerifyTokenRequest extends RequestData<VerifyTokenRequestResult> {
  /** Survives build minification: VerifyTokenRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'VerifyTokenRequest'

  @hasPII(true)
  public readonly token: string

  @hasPII(true)
  public readonly tokenHash: string

  constructor(data: VerifyTokenRequestData) {
    super()
    this.token = data.token
    this.tokenHash = data.tokenHash
  }
}
