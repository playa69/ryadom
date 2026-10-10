import { RequestData } from 'mediatr-ts'
import type { SetUserAnalyticsOptOutCommandResult } from './set-user-analytics-opt-out.types'

export interface SetUserAnalyticsOptOutCommandData {
  userId: string
  optOut: boolean
}

/**
 * Records whether the person wants product analytics off for their account. The server consults it
 * before reporting anything about them, on every device they use.
 */
export class SetUserAnalyticsOptOutCommand extends RequestData<SetUserAnalyticsOptOutCommandResult> {
  static readonly requestName = 'SetUserAnalyticsOptOutCommand'

  public readonly userId: string
  public readonly optOut: boolean

  constructor(data: SetUserAnalyticsOptOutCommandData) {
    super()
    this.userId = data.userId
    this.optOut = data.optOut
  }
}
