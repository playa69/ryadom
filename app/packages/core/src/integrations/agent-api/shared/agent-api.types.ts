/**
 * Response shapes of `agent-api` as the provider returns them, without
 * domain DTOs. Only what the application uses today is here: a field joins when a screen needs it.
 */

export interface AgentDialogSummaryResponse {
  title: string
  themes: string[]
  /** Self-reported tension before and after the conversation, 1-10. */
  tensionBefore?: number | null
  tensionAfter?: number | null
}

export interface AgentDialogListItemResponse {
  dialogId: string
  startedAt: string
  endedAt: string | null
  summary: AgentDialogSummaryResponse | null
  /** `off`: a conversation "without memory". Absent from an agent without memory, which means `on`. */
  memoryMode?: string
}

export interface AgentMessageResponse {
  id: string
  role: 'user' | 'assistant'
  text: string
  createdAt: string
}

export interface AgentDialogResponse extends AgentDialogListItemResponse {
  messages: AgentMessageResponse[]
}
