// 1. Handler imports
import './start-dialog/start-agent-dialog.handler'
import './list-dialogs/list-agent-dialogs.handler'
import './get-dialog/get-agent-dialog.handler'
import './end-dialog/end-agent-dialog.handler'
import './erase-user/erase-agent-user.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { StartAgentDialogRequest } from './start-dialog/start-agent-dialog.request'
export type { StartAgentDialogRequestData } from './start-dialog/start-agent-dialog.request'
export { ListAgentDialogsRequest } from './list-dialogs/list-agent-dialogs.request'
export type { ListAgentDialogsRequestData } from './list-dialogs/list-agent-dialogs.request'
export { GetAgentDialogRequest } from './get-dialog/get-agent-dialog.request'
export type { GetAgentDialogRequestData } from './get-dialog/get-agent-dialog.request'
export { EndAgentDialogRequest } from './end-dialog/end-agent-dialog.request'
export type { EndAgentDialogRequestData } from './end-dialog/end-agent-dialog.request'
export { EraseAgentUserRequest } from './erase-user/erase-agent-user.request'
export type { EraseAgentUserRequestData } from './erase-user/erase-agent-user.request'

// 3. Type re-exports
export type { StartAgentDialogResponse } from './start-dialog/start-agent-dialog.types'
export type { ListAgentDialogsResponse } from './list-dialogs/list-agent-dialogs.types'
export type { GetAgentDialogResult } from './get-dialog/get-agent-dialog.types'
export { GetAgentDialogRequestErrorCode } from './get-dialog/get-agent-dialog.types'
export type { EndAgentDialogResult } from './end-dialog/end-agent-dialog.types'
export { EndAgentDialogRequestErrorCode } from './end-dialog/end-agent-dialog.types'
export type { EraseAgentUserResponse } from './erase-user/erase-agent-user.types'
export {
  type AgentDialogListItemResponse,
  type AgentDialogResponse,
  type AgentDialogSummaryResponse,
  type AgentMessageResponse,
} from './shared/agent-api.types'

// 4. Union type
import type { StartAgentDialogRequest } from './start-dialog/start-agent-dialog.request'
import type { ListAgentDialogsRequest } from './list-dialogs/list-agent-dialogs.request'
import type { GetAgentDialogRequest } from './get-dialog/get-agent-dialog.request'
import type { EndAgentDialogRequest } from './end-dialog/end-agent-dialog.request'
import type { EraseAgentUserRequest } from './erase-user/erase-agent-user.request'

export type AgentApiIntegrationRequests =
  | StartAgentDialogRequest
  | ListAgentDialogsRequest
  | GetAgentDialogRequest
  | EndAgentDialogRequest
  | EraseAgentUserRequest

// 5. Facade
export class AgentApiIntegration implements IAgentApiIntegration {
  async execute<T extends AgentApiIntegrationRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: AgentApiIntegrationRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IAgentApiIntegration {
  execute<T extends AgentApiIntegrationRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const agentApiIntegration: IAgentApiIntegration = new AgentApiIntegration()
