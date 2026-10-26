import type { AgentRecapItemResponse } from '../shared/agent-api.types'

export interface ListAgentRecapsResult {
  items: AgentRecapItemResponse[]
  next: string | null
}
