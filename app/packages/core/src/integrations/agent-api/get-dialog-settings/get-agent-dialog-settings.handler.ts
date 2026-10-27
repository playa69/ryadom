import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent } from '../shared/request'
import { GetAgentDialogSettingsRequest } from './get-agent-dialog-settings.request'
import type { GetAgentDialogSettingsResult } from './get-agent-dialog-settings.types'

@requestHandler(GetAgentDialogSettingsRequest)
export class GetAgentDialogSettingsRequestHandler
  implements RequestHandler<GetAgentDialogSettingsRequest, GetAgentDialogSettingsResult>
{
  async handle(request: GetAgentDialogSettingsRequest): Promise<GetAgentDialogSettingsResult> {
    const { status, body } = await callAgent<{ recapEnabled?: boolean }>(
      `/v1/users/${encodeURIComponent(request.userId)}/dialog-settings`,
    )
    if (status !== 200) throw new Error(`Agent API refused to return dialog settings: ${status}`)
    return { recapEnabled: body?.recapEnabled !== false }
  }
}
