import { randomUUID } from 'node:crypto'
import type { AuditLogAction } from '@ryadom/db/schema'
import { auditLogManager, RecordAuditLogEntryCommand } from '../../../managers/audit-log-manager'

/** An admin action audit entry: who did what to whom (the target's email as a snapshot at the time). */
export async function recordAudit(entry: {
  adminEmail: string
  action: AuditLogAction
  targetUserId: string
  targetEmail: string
  payload?: Record<string, unknown>
}): Promise<void> {
  await auditLogManager.execute(
    new RecordAuditLogEntryCommand({
      entryId: randomUUID(),
      adminEmail: entry.adminEmail,
      action: entry.action,
      targetUserId: entry.targetUserId,
      targetEmail: entry.targetEmail,
      payload: entry.payload ?? null,
    }),
  )
}
