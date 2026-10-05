import { RequestData } from 'mediatr-ts'
import type { TouchUserActivityCommandResult } from './touch-user-activity.types'

export interface TouchUserActivityCommandData {
  userId: string
  /** The moment to record. */
  at: Date
  /** Nothing is written when the person was seen after this: a session refreshes every few minutes. */
  unlessSeenAfter: Date
}

export class TouchUserActivityCommand extends RequestData<TouchUserActivityCommandResult> {
  /** Survives minification: TouchUserActivityCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'TouchUserActivityCommand'

  public readonly userId: string
  public readonly at: Date
  public readonly unlessSeenAfter: Date

  constructor(data: TouchUserActivityCommandData) {
    super()
    this.userId = data.userId
    this.at = data.at
    this.unlessSeenAfter = data.unlessSeenAfter
  }
}
