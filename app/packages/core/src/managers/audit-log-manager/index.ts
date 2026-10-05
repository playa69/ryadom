// 1. Handler imports
import './commands/record-audit-log-entry/record-audit-log-entry.handler'
import './queries/get-audit-log/get-audit-log.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { RecordAuditLogEntryCommand } from './commands/record-audit-log-entry/record-audit-log-entry.command'
export type { RecordAuditLogEntryCommandData } from './commands/record-audit-log-entry/record-audit-log-entry.command'
export { GetAuditLogQuery } from './queries/get-audit-log/get-audit-log.query'
export type { GetAuditLogQueryData } from './queries/get-audit-log/get-audit-log.query'

// 3. Type re-exports
export type { RecordAuditLogEntryCommandResult } from './commands/record-audit-log-entry/record-audit-log-entry.types'
export type { GetAuditLogQueryResult } from './queries/get-audit-log/get-audit-log.types'
export type { AuditLogEntryDTO } from './shared/audit-log-entry.dto'
export { AUDIT_LOG_ACTIONS, type AuditLogAction } from '@ryadom/db/schema'

// 4. Union type
import type { RecordAuditLogEntryCommand } from './commands/record-audit-log-entry/record-audit-log-entry.command'
import type { GetAuditLogQuery } from './queries/get-audit-log/get-audit-log.query'

export type AuditLogManagerRequests =
  | RecordAuditLogEntryCommand
  | GetAuditLogQuery

// 5. Facade
export class AuditLogManager implements IAuditLogManager {
  async execute<T extends AuditLogManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: AuditLogManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IAuditLogManager {
  execute<T extends AuditLogManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const auditLogManager: IAuditLogManager = new AuditLogManager()
