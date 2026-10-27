import { RequestData } from 'mediatr-ts'
import type { PutAgentDialogSettingsResult } from './put-agent-dialog-settings.types'

export interface PutAgentDialogSettingsRequestData {
  userId: string
  recapEnabled: boolean
}

/** `PUT /v1/users/{userId}/dialog-settings`: «Подводить итог автоматически». */
export class PutAgentDialogSettingsRequest extends RequestData<PutAgentDialogSettingsResult> {
  /** Survives build minification: PutAgentDialogSettingsRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'PutAgentDialogSettingsRequest'

  public readonly userId: string
  public readonly recapEnabled: boolean

  constructor(data: PutAgentDialogSettingsRequestData) {
    super()
    this.userId = data.userId
    this.recapEnabled = data.recapEnabled
  }
}
