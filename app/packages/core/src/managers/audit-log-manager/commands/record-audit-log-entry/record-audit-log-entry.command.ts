import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { AuditLogAction } from '@ryadom/db/schema'
import type { RecordAuditLogEntryCommandResult } from './record-audit-log-entry.types'

export interface RecordAuditLogEntryCommandData {
  entryId: string
  adminEmail: string
  action: AuditLogAction
  targetUserId: string | null
  targetEmail: string | null
  payload: Record<string, unknown> | null
}

export class RecordAuditLogEntryCommand extends RequestData<RecordAuditLogEntryCommandResult> {
  static readonly requestName = 'RecordAuditLogEntryCommand'

  public readonly entryId: string

  @hasPII()
  public readonly adminEmail: string

  public readonly action: AuditLogAction
  public readonly targetUserId: string | null

  @hasPII()
  public readonly targetEmail: string | null

  public readonly payload: Record<string, unknown> | null

  constructor(data: RecordAuditLogEntryCommandData) {
    super()
    this.entryId = data.entryId
    this.adminEmail = data.adminEmail
    this.action = data.action
    this.targetUserId = data.targetUserId
    this.targetEmail = data.targetEmail
    this.payload = data.payload
  }
}
