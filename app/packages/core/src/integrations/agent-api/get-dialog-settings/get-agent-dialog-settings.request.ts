import { RequestData } from 'mediatr-ts'
import type { GetAgentDialogSettingsResult } from './get-agent-dialog-settings.types'

export interface GetAgentDialogSettingsRequestData {
  userId: string
}

/** `GET /v1/users/{userId}/dialog-settings`. */
export class GetAgentDialogSettingsRequest extends RequestData<GetAgentDialogSettingsResult> {
  /** Survives build minification: GetAgentDialogSettingsRequest.name is not kept in production. Used by LoggingBehavior. */
  static readonly requestName = 'GetAgentDialogSettingsRequest'

  public readonly userId: string

  constructor(data: GetAgentDialogSettingsRequestData) {
    super()
    this.userId = data.userId
  }
}
