import { RequestData } from 'mediatr-ts'
import type { GetSelfCheckConsentResult } from './get-self-check-consent.types'

export interface GetSelfCheckConsentOperationData {
  userId: string
}

export class GetSelfCheckConsentOperation extends RequestData<GetSelfCheckConsentResult> {
  /** Survives build minification: GetSelfCheckConsentOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetSelfCheckConsentOperation'

  public readonly userId: string

  constructor(data: GetSelfCheckConsentOperationData) {
    super()
    this.userId = data.userId
  }
}
