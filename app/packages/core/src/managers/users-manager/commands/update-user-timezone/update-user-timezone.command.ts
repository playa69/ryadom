import { RequestData } from 'mediatr-ts'
import type { UpdateUserTimezoneCommandResult } from './update-user-timezone.types'

export interface UpdateUserTimezoneCommandData {
  userId: string
  timezone: string
}

/** Sets the IANA time zone the diary day, the reminder and the weekly summary follow. */
export class UpdateUserTimezoneCommand extends RequestData<UpdateUserTimezoneCommandResult> {
  static readonly requestName = 'UpdateUserTimezoneCommand'

  public readonly userId: string
  public readonly timezone: string

  constructor(data: UpdateUserTimezoneCommandData) {
    super()
    this.userId = data.userId
    this.timezone = data.timezone
  }
}
