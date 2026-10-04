import { RequestData } from 'mediatr-ts'
import type { GetAuditLogQueryResult } from './get-audit-log.types'

export interface GetAuditLogQueryData {
  page: number
  pageSize: number
  targetUserId?: string
}

export class GetAuditLogQuery extends RequestData<GetAuditLogQueryResult> {
  /** Survives minification: GetAuditLogQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetAuditLogQuery'

  public readonly page: number
  public readonly pageSize: number
  public readonly targetUserId?: string

  constructor(data: GetAuditLogQueryData) {
    super()
    this.page = data.page
    this.pageSize = data.pageSize
    this.targetUserId = data.targetUserId
  }
}
