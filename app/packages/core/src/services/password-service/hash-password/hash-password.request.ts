import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../shared'
import type { HashPasswordRequestResult } from './hash-password.types'

export interface HashPasswordRequestData {
  password: string
}

export class HashPasswordRequest extends RequestData<HashPasswordRequestResult> {
  /** Survives build minification: HashPasswordRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'HashPasswordRequest'

  @hasPII(true)
  public readonly password: string

  constructor(data: HashPasswordRequestData) {
    super()
    this.password = data.password
  }
}
