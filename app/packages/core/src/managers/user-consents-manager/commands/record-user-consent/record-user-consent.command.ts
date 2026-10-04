import { RequestData } from 'mediatr-ts'
import type { UserConsentKind } from '@ryadom/db/schema'
import type { RecordUserConsentCommandResult } from './record-user-consent.types'

export interface RecordUserConsentCommandData {
  recordId: string
  userId: string
  kind: UserConsentKind
  version: string
  acceptedAt: Date
}

export class RecordUserConsentCommand extends RequestData<RecordUserConsentCommandResult> {
  /** Survives minification: RecordUserConsentCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'RecordUserConsentCommand'

  public readonly recordId: string
  public readonly userId: string
  public readonly kind: UserConsentKind
  public readonly version: string
  public readonly acceptedAt: Date

  constructor(data: RecordUserConsentCommandData) {
    super()
    this.recordId = data.recordId
    this.userId = data.userId
    this.kind = data.kind
    this.version = data.version
    this.acceptedAt = data.acceptedAt
  }
}
