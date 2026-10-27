import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { callAgent } from '../shared/request'
import { PutAgentDialogSettingsRequest } from './put-agent-dialog-settings.request'
import type { PutAgentDialogSettingsResult } from './put-agent-dialog-settings.types'

@requestHandler(PutAgentDialogSettingsRequest)
export class PutAgentDialogSettingsRequestHandler
  implements RequestHandler<PutAgentDialogSettingsRequest, PutAgentDialogSettingsResult>
{
  async handle(request: PutAgentDialogSettingsRequest): Promise<PutAgentDialogSettingsResult> {
    const { status, body } = await callAgent<{ recapEnabled?: boolean }>(
      `/v1/users/${encodeURIComponent(request.userId)}/dialog-settings`,
      { method: 'PUT', body: { recapEnabled: request.recapEnabled } },
    )
    if (status !== 200) throw new Error(`Agent API refused to save dialog settings: ${status}`)
    return { recapEnabled: body?.recapEnabled !== false }
  }
}
