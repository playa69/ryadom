import { RequestData } from 'mediatr-ts'
import type { DiarySummaryKind } from '@ryadom/db/schema'
import type { MarkDiarySummaryForRecomputeCommandResult } from './mark-diary-summary-for-recompute.types'

export interface MarkDiarySummaryForRecomputeCommandData {
  userId: string
  kind: DiarySummaryKind
  periodStart: string
}

/**
 * Leaves a marker that the scheduler rebuilds this period: a `pending` row with no text and `stats.recompute`,
 * dated at the epoch so that any replica may claim it at once. It is never shown. A period that already has a
 * row (a replica is writing it, or it was rebuilt meanwhile) keeps it.
 */
export class MarkDiarySummaryForRecomputeCommand extends RequestData<MarkDiarySummaryForRecomputeCommandResult> {
  /** Survives build minification: MarkDiarySummaryForRecomputeCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'MarkDiarySummaryForRecomputeCommand'

  public readonly userId: string
  public readonly kind: DiarySummaryKind
  public readonly periodStart: string

  constructor(data: MarkDiarySummaryForRecomputeCommandData) {
    super()
    this.userId = data.userId
    this.kind = data.kind
    this.periodStart = data.periodStart
  }
}
