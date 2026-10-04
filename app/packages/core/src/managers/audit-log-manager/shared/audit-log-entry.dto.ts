import type { AuditLogAction, AuditLogRow } from '@ryadom/db/schema'

export interface AuditLogEntryDTO {
  id: string
  adminEmail: string
  action: AuditLogAction
  /** null means the user has since disappeared from the database (`set null` reference). */
  targetUserId: string | null
  /** The user's email as of the moment of the action. */
  targetEmail: string | null
  payload: Record<string, unknown> | null
  createdAt: Date
}

export function toAuditLogEntryDTO(row: AuditLogRow): AuditLogEntryDTO {
  return {
    id: row.id,
    adminEmail: row.adminEmail,
    action: row.action,
    targetUserId: row.targetUserId,
    targetEmail: row.targetEmail,
    payload: row.payload,
    createdAt: row.createdAt,
  }
}
