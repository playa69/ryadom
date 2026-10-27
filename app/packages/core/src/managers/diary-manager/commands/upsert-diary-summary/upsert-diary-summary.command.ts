import { RequestData } from 'mediatr-ts'
import { hasPII } from '../../../../shared'
import type { DiarySummaryKind } from '@ryadom/db/schema'
import type { UpsertDiarySummaryCommandResult } from './upsert-diary-summary.types'

export interface UpsertDiarySummaryCommandData {
  userId: string
  kind: DiarySummaryKind
  periodStart: string
  text: string
  stats: Record<string, unknown> | null
  generatedAt: Date
}

export class UpsertDiarySummaryCommand extends RequestData<UpsertDiarySummaryCommandResult> {
  /** Survives build minification: UpsertDiarySummaryCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'UpsertDiarySummaryCommand'

  public readonly userId: string
  public readonly kind: DiarySummaryKind
  public readonly periodStart: string
  @hasPII(true)
  public readonly text: string
  @hasPII(true)
  public readonly stats: Record<string, unknown> | null
  public readonly generatedAt: Date

  constructor(data: UpsertDiarySummaryCommandData) {
    super()
    this.userId = data.userId
    this.kind = data.kind
    this.periodStart = data.periodStart
    this.text = data.text
    this.stats = data.stats
    this.generatedAt = data.generatedAt
  }
}
