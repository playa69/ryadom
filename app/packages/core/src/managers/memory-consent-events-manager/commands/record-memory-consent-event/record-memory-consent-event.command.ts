import { RequestData } from 'mediatr-ts'
import type { MemoryConsentAction } from '@ryadom/db/schema'
import type { RecordMemoryConsentEventCommandResult } from './record-memory-consent-event.types'

export interface RecordMemoryConsentEventCommandData {
  eventId: string
  userId: string
  action: MemoryConsentAction
  version: string
  at: Date
}

export class RecordMemoryConsentEventCommand extends RequestData<RecordMemoryConsentEventCommandResult> {
  /** Survives minification: RecordMemoryConsentEventCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'RecordMemoryConsentEventCommand'

  public readonly eventId: string
  public readonly userId: string
  public readonly action: MemoryConsentAction
  public readonly version: string
  public readonly at: Date

  constructor(data: RecordMemoryConsentEventCommandData) {
    super()
    this.eventId = data.eventId
    this.userId = data.userId
    this.action = data.action
    this.version = data.version
    this.at = data.at
  }
}
