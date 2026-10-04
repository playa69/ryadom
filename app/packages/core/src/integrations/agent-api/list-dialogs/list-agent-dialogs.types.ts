import type { AgentDialogListItemResponse } from '../shared/agent-api.types'

export interface ListAgentDialogsResponse {
  items: AgentDialogListItemResponse[]
  next: string | null
}
