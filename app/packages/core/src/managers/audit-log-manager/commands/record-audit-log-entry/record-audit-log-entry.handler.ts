import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { auditLog } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { RecordAuditLogEntryCommand } from './record-audit-log-entry.command'
import type { RecordAuditLogEntryCommandResult } from './record-audit-log-entry.types'

@requestHandler(RecordAuditLogEntryCommand)
export class RecordAuditLogEntryCommandHandler implements RequestHandler<
  RecordAuditLogEntryCommand,
  RecordAuditLogEntryCommandResult
> {
  async handle(command: RecordAuditLogEntryCommand): Promise<RecordAuditLogEntryCommandResult> {
    await getDb().insert(auditLog).values({
      id: command.entryId,
      adminEmail: command.adminEmail.trim().toLowerCase(),
      action: command.action,
      targetUserId: command.targetUserId,
      targetEmail: command.targetEmail,
      payload: command.payload,
      createdAt: new Date(),
    })
    return { success: true }
  }
}
