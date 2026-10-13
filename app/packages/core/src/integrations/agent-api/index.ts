// 1. Handler imports
import './start-dialog/start-agent-dialog.handler'
import './list-dialogs/list-agent-dialogs.handler'
import './get-dialog/get-agent-dialog.handler'
import './end-dialog/end-agent-dialog.handler'
import './erase-user/erase-agent-user.handler'
import './get-memory/get-agent-memory.handler'
import './update-memory-settings/update-agent-memory-settings.handler'
import './create-memory-fact/create-agent-memory-fact.handler'
import './update-memory-fact/update-agent-memory-fact.handler'
import './delete-memory-fact/delete-agent-memory-fact.handler'
import './forget-memory/forget-agent-memory.handler'
import './get-memory-changes/get-agent-memory-changes.handler'
import './export-memory/export-agent-memory.handler'

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
export { GetAgentMemoryRequest } from './get-memory/get-agent-memory.request'
export type { GetAgentMemoryRequestData } from './get-memory/get-agent-memory.request'
export { UpdateAgentMemorySettingsRequest } from './update-memory-settings/update-agent-memory-settings.request'
export type { UpdateAgentMemorySettingsRequestData } from './update-memory-settings/update-agent-memory-settings.request'
export { CreateAgentMemoryFactRequest } from './create-memory-fact/create-agent-memory-fact.request'
export type { CreateAgentMemoryFactRequestData } from './create-memory-fact/create-agent-memory-fact.request'
export { UpdateAgentMemoryFactRequest } from './update-memory-fact/update-agent-memory-fact.request'
export type { UpdateAgentMemoryFactRequestData } from './update-memory-fact/update-agent-memory-fact.request'
export { DeleteAgentMemoryFactRequest } from './delete-memory-fact/delete-agent-memory-fact.request'
export type { DeleteAgentMemoryFactRequestData } from './delete-memory-fact/delete-agent-memory-fact.request'
export { ForgetAgentMemoryRequest } from './forget-memory/forget-agent-memory.request'
export type { ForgetAgentMemoryRequestData } from './forget-memory/forget-agent-memory.request'
export { GetAgentMemoryChangesRequest } from './get-memory-changes/get-agent-memory-changes.request'
export type { GetAgentMemoryChangesRequestData } from './get-memory-changes/get-agent-memory-changes.request'
export { ExportAgentMemoryRequest } from './export-memory/export-agent-memory.request'
export type { ExportAgentMemoryRequestData } from './export-memory/export-agent-memory.request'

// 3. Type re-exports
export type { StartAgentDialogResponse } from './start-dialog/start-agent-dialog.types'
export type { ListAgentDialogsResponse } from './list-dialogs/list-agent-dialogs.types'
export type { GetAgentDialogResult } from './get-dialog/get-agent-dialog.types'
export { GetAgentDialogRequestErrorCode } from './get-dialog/get-agent-dialog.types'
export type { EndAgentDialogResult } from './end-dialog/end-agent-dialog.types'
export { EndAgentDialogRequestErrorCode } from './end-dialog/end-agent-dialog.types'
export type { EraseAgentUserResponse } from './erase-user/erase-agent-user.types'
export type { GetAgentMemoryResponse } from './get-memory/get-agent-memory.types'
export type { UpdateAgentMemorySettingsResult } from './update-memory-settings/update-agent-memory-settings.types'
export { UpdateAgentMemorySettingsRequestErrorCode } from './update-memory-settings/update-agent-memory-settings.types'
export type { CreateAgentMemoryFactResult } from './create-memory-fact/create-agent-memory-fact.types'
export { CreateAgentMemoryFactRequestErrorCode } from './create-memory-fact/create-agent-memory-fact.types'
export type { UpdateAgentMemoryFactResult } from './update-memory-fact/update-agent-memory-fact.types'
export { UpdateAgentMemoryFactRequestErrorCode } from './update-memory-fact/update-agent-memory-fact.types'
export type { DeleteAgentMemoryFactResult } from './delete-memory-fact/delete-agent-memory-fact.types'
export { DeleteAgentMemoryFactRequestErrorCode } from './delete-memory-fact/delete-agent-memory-fact.types'
export type { ForgetAgentMemoryResult } from './forget-memory/forget-agent-memory.types'
export { ForgetAgentMemoryRequestErrorCode } from './forget-memory/forget-agent-memory.types'
export type { GetAgentMemoryChangesResult } from './get-memory-changes/get-agent-memory-changes.types'
export { GetAgentMemoryChangesRequestErrorCode } from './get-memory-changes/get-agent-memory-changes.types'
export type { ExportAgentMemoryResponse } from './export-memory/export-agent-memory.types'
export {
  type AgentDialogListItemResponse,
  type AgentDialogResponse,
  type AgentDialogSummaryResponse,
  type AgentMessageResponse,
} from './shared/agent-api.types'
export type {
  AgentDialogMemoryMode,
  AgentMemoryChangeOp,
  AgentMemoryChangesResponse,
  AgentMemoryChangesStatus,
  AgentMemoryEventResponse,
  AgentMemoryExportResponse,
  AgentMemoryFactCategory,
  AgentMemoryFactOrigin,
  AgentMemoryFactResponse,
  AgentMemoryFactSensitivity,
  AgentMemoryFactSlots,
  AgentMemoryFactSource,
  AgentMemoryFactStatus,
  AgentMemoryMode,
  AgentMemoryResponse,
  AgentMemorySettingsResponse,
} from './shared/agent-memory.types'

// 4. Union type
import type { StartAgentDialogRequest } from './start-dialog/start-agent-dialog.request'
import type { ListAgentDialogsRequest } from './list-dialogs/list-agent-dialogs.request'
import type { GetAgentDialogRequest } from './get-dialog/get-agent-dialog.request'
import type { EndAgentDialogRequest } from './end-dialog/end-agent-dialog.request'
import type { EraseAgentUserRequest } from './erase-user/erase-agent-user.request'
import type { GetAgentMemoryRequest } from './get-memory/get-agent-memory.request'
import type { UpdateAgentMemorySettingsRequest } from './update-memory-settings/update-agent-memory-settings.request'
import type { CreateAgentMemoryFactRequest } from './create-memory-fact/create-agent-memory-fact.request'
import type { UpdateAgentMemoryFactRequest } from './update-memory-fact/update-agent-memory-fact.request'
import type { DeleteAgentMemoryFactRequest } from './delete-memory-fact/delete-agent-memory-fact.request'
import type { ForgetAgentMemoryRequest } from './forget-memory/forget-agent-memory.request'
import type { GetAgentMemoryChangesRequest } from './get-memory-changes/get-agent-memory-changes.request'
import type { ExportAgentMemoryRequest } from './export-memory/export-agent-memory.request'

export type AgentApiIntegrationRequests =
  | StartAgentDialogRequest
  | ListAgentDialogsRequest
  | GetAgentDialogRequest
  | EndAgentDialogRequest
  | EraseAgentUserRequest
  | GetAgentMemoryRequest
  | UpdateAgentMemorySettingsRequest
  | CreateAgentMemoryFactRequest
  | UpdateAgentMemoryFactRequest
  | DeleteAgentMemoryFactRequest
  | ForgetAgentMemoryRequest
  | GetAgentMemoryChangesRequest
  | ExportAgentMemoryRequest

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
