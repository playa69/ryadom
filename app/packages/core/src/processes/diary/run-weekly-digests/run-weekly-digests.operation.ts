import { RequestData } from 'mediatr-ts'
import type { RunWeeklyDigestsResult } from './run-weekly-digests.types'

export interface RunWeeklyDigestsOperationData {
  now?: Date
  limit?: number
}

export class RunWeeklyDigestsOperation extends RequestData<RunWeeklyDigestsResult> {
  /** Survives build minification: RunWeeklyDigestsOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RunWeeklyDigestsOperation'

  public readonly now?: Date
  public readonly limit?: number

  constructor(data: RunWeeklyDigestsOperationData = {}) {
    super()
    this.now = data.now
    this.limit = data.limit
  }
}
