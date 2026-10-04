import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { HashTokenRequestResult } from './hash-token.types'

export interface HashTokenRequestData {
  token: string
}

export class HashTokenRequest extends RequestData<HashTokenRequestResult> {
  /** Survives build minification: HashTokenRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'HashTokenRequest'

  @hasPII(true)
  public readonly token: string

  constructor(data: HashTokenRequestData) {
    super()
    this.token = data.token
  }
}
