import { RequestData } from 'mediatr-ts'
import type { RunReminderTickResult } from './run-reminder-tick.types'

export interface RunReminderTickOperationData {
  now?: Date
  batch?: number
}

export class RunReminderTickOperation extends RequestData<RunReminderTickResult> {
  /** Survives build minification: RunReminderTickOperation.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'RunReminderTickOperation'

  public readonly now?: Date
  public readonly batch?: number

  constructor(data: RunReminderTickOperationData = {}) {
    super()
    this.now = data.now
    this.batch = data.batch
  }
}
