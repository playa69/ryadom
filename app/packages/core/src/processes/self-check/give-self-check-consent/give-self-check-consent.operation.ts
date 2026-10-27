import { RequestData } from 'mediatr-ts'
import type { GiveSelfCheckConsentResult } from './give-self-check-consent.types'

export interface GiveSelfCheckConsentOperationData {
  userId: string
  version: string
}

export class GiveSelfCheckConsentOperation extends RequestData<GiveSelfCheckConsentResult> {
  /** Survives build minification: GiveSelfCheckConsentOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GiveSelfCheckConsentOperation'

  public readonly userId: string
  public readonly version: string

  constructor(data: GiveSelfCheckConsentOperationData) {
    super()
    this.userId = data.userId
    this.version = data.version
  }
}
