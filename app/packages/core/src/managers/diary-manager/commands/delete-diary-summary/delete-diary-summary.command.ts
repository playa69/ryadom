import { RequestData } from 'mediatr-ts'
import type { DiarySummaryKind } from '@ryadom/db/schema'
import type { DeleteDiarySummaryCommandResult } from './delete-diary-summary.types'

export interface DeleteDiarySummaryCommandData {
  userId: string
  kind: DiarySummaryKind
  periodStart: string
  /** `ready` removes the text people see; `pending` removes a recompute marker (or a stale claim) that is not one. */
  status: 'ready' | 'pending'
}

/** Removes the summary of one period (idempotent: nothing there is the same outcome). */
export class DeleteDiarySummaryCommand extends RequestData<DeleteDiarySummaryCommandResult> {
  /** Survives build minification: DeleteDiarySummaryCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'DeleteDiarySummaryCommand'

  public readonly userId: string
  public readonly kind: DiarySummaryKind
  public readonly periodStart: string
  public readonly status: 'ready' | 'pending'

  constructor(data: DeleteDiarySummaryCommandData) {
    super()
    this.userId = data.userId
    this.kind = data.kind
    this.periodStart = data.periodStart
    this.status = data.status
  }
}
