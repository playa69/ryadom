import { RequestData } from 'mediatr-ts'
import type { GetLatestMemoryConsentEventQueryResult } from './get-latest-memory-consent-event.types'

export interface GetLatestMemoryConsentEventQueryData {
  userId: string
}

export class GetLatestMemoryConsentEventQuery extends RequestData<GetLatestMemoryConsentEventQueryResult> {
  /** Survives minification: GetLatestMemoryConsentEventQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetLatestMemoryConsentEventQuery'

  public readonly userId: string

  constructor(data: GetLatestMemoryConsentEventQueryData) {
    super()
    this.userId = data.userId
  }
}
