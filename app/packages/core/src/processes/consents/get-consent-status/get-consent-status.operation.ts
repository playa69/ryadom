import { RequestData } from 'mediatr-ts'
import type { GetConsentStatusResult } from './get-consent-status.types'

export interface GetConsentStatusOperationData {
  userId: string
}

export class GetConsentStatusOperation extends RequestData<GetConsentStatusResult> {
  /** Survives minification: GetConsentStatusOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetConsentStatusOperation'

  public readonly userId: string

  constructor(data: GetConsentStatusOperationData) {
    super()
    this.userId = data.userId
  }
}
