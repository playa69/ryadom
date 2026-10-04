import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { count, desc, eq } from 'drizzle-orm'
import { auditLog } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { GetAuditLogQuery } from './get-audit-log.query'
import type { GetAuditLogQueryResult } from './get-audit-log.types'
import { toAuditLogEntryDTO } from '../../shared/audit-log-entry.dto'

/** Paginated log, newest first; `targetUserId` narrows it to entries about one user. */
@requestHandler(GetAuditLogQuery)
export class GetAuditLogQueryHandler implements RequestHandler<GetAuditLogQuery, GetAuditLogQueryResult> {
  async handle(query: GetAuditLogQuery): Promise<GetAuditLogQueryResult> {
    if (query.targetUserId !== undefined && !isUuid(query.targetUserId)) {
      return { success: true, entries: [], total: 0 }
    }
    const where = query.targetUserId !== undefined ? eq(auditLog.targetUserId, query.targetUserId) : undefined
    const db = getDb()
    const [rows, totals] = await Promise.all([
      db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize),
      db.select({ value: count() }).from(auditLog).where(where),
    ])
    return { success: true, entries: rows.map(toAuditLogEntryDTO), total: totals[0]?.value ?? 0 }
  }
}
