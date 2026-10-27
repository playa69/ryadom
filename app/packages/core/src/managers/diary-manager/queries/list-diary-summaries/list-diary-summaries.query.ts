import { RequestData } from 'mediatr-ts'
import type { DiarySummaryKind } from '@ryadom/db/schema'
import type { ListDiarySummariesQueryResult } from './list-diary-summaries.types'

export interface ListDiarySummariesQueryData {
  userId: string
  kind: DiarySummaryKind
  before?: string
  from?: string
  to?: string
  limit?: number
}

export class ListDiarySummariesQuery extends RequestData<ListDiarySummariesQueryResult> {
  /** Survives build minification: ListDiarySummariesQuery.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ListDiarySummariesQuery'

  public readonly userId: string
  public readonly kind: DiarySummaryKind
  public readonly before?: string
  public readonly from?: string
  public readonly to?: string
  public readonly limit?: number

  constructor(data: ListDiarySummariesQueryData) {
    super()
    this.userId = data.userId
    this.kind = data.kind
    this.before = data.before
    this.from = data.from
    this.to = data.to
    this.limit = data.limit
  }
}
