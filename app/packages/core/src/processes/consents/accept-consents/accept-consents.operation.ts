import { RequestData } from 'mediatr-ts'
import type { AcceptConsentsResult } from './accept-consents.types'

export interface AcceptConsentsOperationData {
  userId: string
  ageConfirmed: boolean
  disclaimerAccepted: boolean
  offerAccepted: boolean
  /** The version of the terms that was on the screen when the person accepted. */
  offerVersion: string
}

export class AcceptConsentsOperation extends RequestData<AcceptConsentsResult> {
  /** Survives minification: AcceptConsentsOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'AcceptConsentsOperation'

  public readonly userId: string
  public readonly ageConfirmed: boolean
  public readonly disclaimerAccepted: boolean
  public readonly offerAccepted: boolean
  public readonly offerVersion: string

  constructor(data: AcceptConsentsOperationData) {
    super()
    this.userId = data.userId
    this.ageConfirmed = data.ageConfirmed
    this.disclaimerAccepted = data.disclaimerAccepted
    this.offerAccepted = data.offerAccepted
    this.offerVersion = data.offerVersion
  }
}
