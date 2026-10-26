import { RequestData } from 'mediatr-ts'

import type { PutDialogSettingsResult } from './put-dialog-settings.types'

export interface PutDialogSettingsOperationData {
  userId: string
  recapEnabled: boolean
}

/** Turns «Подводить итог автоматически» on or off. */
export class PutDialogSettingsOperation extends RequestData<PutDialogSettingsResult> {
  /** Survives minification: PutDialogSettingsOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'PutDialogSettingsOperation'

  public readonly userId: string
  public readonly recapEnabled: boolean

  constructor(data: PutDialogSettingsOperationData) {
    super()
    this.userId = data.userId
    this.recapEnabled = data.recapEnabled
  }
}
