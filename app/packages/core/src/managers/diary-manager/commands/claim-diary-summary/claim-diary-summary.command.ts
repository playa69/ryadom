import { RequestData } from 'mediatr-ts'
import type { DiarySummaryKind } from '@ryadom/db/schema'
import type { ClaimDiarySummaryCommandResult } from './claim-diary-summary.types'

export interface ClaimDiarySummaryCommandData {
  userId: string
  kind: DiarySummaryKind
  periodStart: string
  now: Date
  /** A `pending` claim made before this moment is stale: its replica is gone. */
  staleBefore: Date
}

/** Takes a period for one replica by a `pending` row; the unique key lets exactly one of several win. */
export class ClaimDiarySummaryCommand extends RequestData<ClaimDiarySummaryCommandResult> {
  /** Survives build minification: ClaimDiarySummaryCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ClaimDiarySummaryCommand'

  public readonly userId: string
  public readonly kind: DiarySummaryKind
  public readonly periodStart: string
  public readonly now: Date
  public readonly staleBefore: Date

  constructor(data: ClaimDiarySummaryCommandData) {
    super()
    this.userId = data.userId
    this.kind = data.kind
    this.periodStart = data.periodStart
    this.now = data.now
    this.staleBefore = data.staleBefore
  }
}
