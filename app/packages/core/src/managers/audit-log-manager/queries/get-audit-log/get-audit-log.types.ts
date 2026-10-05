import type { AuditLogEntryDTO } from '../../shared/audit-log-entry.dto'

export type GetAuditLogQueryResult = { success: true; entries: AuditLogEntryDTO[]; total: number }
