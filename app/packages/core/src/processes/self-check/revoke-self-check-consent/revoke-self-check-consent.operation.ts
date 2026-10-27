import { RequestData } from 'mediatr-ts'
import type { RevokeSelfCheckConsentResult } from './revoke-self-check-consent.types'

export interface RevokeSelfCheckConsentOperationData {
  userId: string
}

export class RevokeSelfCheckConsentOperation extends RequestData<RevokeSelfCheckConsentResult> {
  /** Survives build minification: RevokeSelfCheckConsentOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RevokeSelfCheckConsentOperation'

  public readonly userId: string

  constructor(data: RevokeSelfCheckConsentOperationData) {
    super()
    this.userId = data.userId
  }
}
