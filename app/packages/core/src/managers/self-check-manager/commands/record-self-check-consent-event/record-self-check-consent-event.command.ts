import { RequestData } from 'mediatr-ts'
import type { SelfCheckConsentAction } from '@ryadom/db/schema'
import type { RecordSelfCheckConsentEventCommandResult } from './record-self-check-consent-event.types'

export interface RecordSelfCheckConsentEventCommandData {
  id: string
  userId: string
  action: SelfCheckConsentAction
  version: string
  at: Date
}

export class RecordSelfCheckConsentEventCommand extends RequestData<RecordSelfCheckConsentEventCommandResult> {
  /** Survives build minification: RecordSelfCheckConsentEventCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RecordSelfCheckConsentEventCommand'

  public readonly id: string
  public readonly userId: string
  public readonly action: SelfCheckConsentAction
  public readonly version: string
  public readonly at: Date

  constructor(data: RecordSelfCheckConsentEventCommandData) {
    super()
    this.id = data.id
    this.userId = data.userId
    this.action = data.action
    this.version = data.version
    this.at = data.at
  }
}
