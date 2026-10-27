import { RequestData } from 'mediatr-ts'
import type { GetSelfCheckConsentQueryResult } from './get-self-check-consent.types'

export interface GetSelfCheckConsentQueryData {
  userId: string
}

export class GetSelfCheckConsentQuery extends RequestData<GetSelfCheckConsentQueryResult> {
  /** Survives build minification: GetSelfCheckConsentQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetSelfCheckConsentQuery'

  public readonly userId: string

  constructor(data: GetSelfCheckConsentQueryData) {
    super()
    this.userId = data.userId
  }
}
