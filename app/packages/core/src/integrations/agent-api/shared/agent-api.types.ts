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
  /** What was said in the whole dialog (the agent counts it); absent from an agent that does not. For analytics only. */
  userMessages?: number | null
  assistantMessages?: number | null
  /** The recap of the conversation (add-mood-diary D13); absent from an agent that has none. */
  recap?: string | null
  recapStatus?: 'pending' | 'ready' | 'none'
  recapSource?: 'manual' | 'draft' | 'auto' | null
  /** Whether a recap can be made for this conversation at all. */
  recapAvailable?: boolean
  /** When the recap was stored, ISO. */
  recapAt?: string | null
}

/** A conversation with its recap, as the list of recaps returns it (the journal and the week summary read it). */
export interface AgentRecapItemResponse {
  dialogId: string
  startedAt: string
  endedAt: string | null
  title: string | null
  recap: string
  recapSource: 'manual' | 'draft' | 'auto' | null
  recapAt: string | null
}

export interface AgentDialogListItemResponse {
  dialogId: string
  startedAt: string
  endedAt: string | null
  summary: AgentDialogSummaryResponse | null
  /** `off`: a conversation "without memory". Absent from an agent without memory, which means `on`. */
  memoryMode?: string
  /** `false`: a conversation kept only as a mark (PROTEUS-246); absent from an agent that has none. */
  saved?: boolean
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
