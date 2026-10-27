import { RequestData } from 'mediatr-ts'

import type { GetDialogSettingsResult } from './get-dialog-settings.types'

export interface GetDialogSettingsOperationData {
  userId: string
}

/** «Подводить итог автоматически». */
export class GetDialogSettingsOperation extends RequestData<GetDialogSettingsResult> {
  /** Survives minification: GetDialogSettingsOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetDialogSettingsOperation'

  public readonly userId: string

  constructor(data: GetDialogSettingsOperationData) {
    super()
    this.userId = data.userId
  }
}
