import { RequestData } from 'mediatr-ts'
import type { DiarySummaryKind } from '@ryadom/db/schema'
import type { ReleaseDiarySummaryCommandResult } from './release-diary-summary.types'

export interface ReleaseDiarySummaryCommandData {
  userId: string
  kind: DiarySummaryKind
  periodStart: string
}

/** The agent did not write the text: the claim is given back (an empty row is deleted, an older text stays). */
export class ReleaseDiarySummaryCommand extends RequestData<ReleaseDiarySummaryCommandResult> {
  /** Survives build minification: ReleaseDiarySummaryCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'ReleaseDiarySummaryCommand'

  public readonly userId: string
  public readonly kind: DiarySummaryKind
  public readonly periodStart: string

  constructor(data: ReleaseDiarySummaryCommandData) {
    super()
    this.userId = data.userId
    this.kind = data.kind
    this.periodStart = data.periodStart
  }
}
