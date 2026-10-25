import { RequestData } from 'mediatr-ts'
import type { RecomputeSummariesAfterDialogDeletedResult } from './recompute-summaries-after-dialog-deleted.types'

export interface RecomputeSummariesAfterDialogDeletedOperationData {
  userId: string
  /** When the deleted conversation was held (its start, from the journal); its week is the one in the person's zone. */
  dialogAt: Date
  now?: Date
}

/**
 * A person deleted a conversation by hand: the text of its week (and the year story built on final weeks) may retell it,
 * so it goes at once, and the scheduler writes it again from what is left. The retention job must NOT call this: a
 * summary is a generalisation without quotes and stays when a conversation only ages out.
 */
export class RecomputeSummariesAfterDialogDeletedOperation extends RequestData<RecomputeSummariesAfterDialogDeletedResult> {
  /** Survives build minification: RecomputeSummariesAfterDialogDeletedOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RecomputeSummariesAfterDialogDeletedOperation'

  public readonly userId: string
  public readonly dialogAt: Date
  public readonly now?: Date

  constructor(data: RecomputeSummariesAfterDialogDeletedOperationData) {
    super()
    this.userId = data.userId
    this.dialogAt = data.dialogAt
    this.now = data.now
  }
}
