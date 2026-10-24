import { RequestData } from 'mediatr-ts'
import type { PauseMoodReminderCommandResult } from './pause-mood-reminder.types'

export interface PauseMoodReminderCommandData {
  userId: string
}

export class PauseMoodReminderCommand extends RequestData<PauseMoodReminderCommandResult> {
  /** Survives build minification: PauseMoodReminderCommand.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'PauseMoodReminderCommand'

  public readonly userId: string

  constructor(data: PauseMoodReminderCommandData) {
    super()
    this.userId = data.userId
  }
}
