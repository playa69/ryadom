export interface StartAgentDialogResponse {
  dialogId: string
  /** true means an already open dialog was returned instead of a new one; never true when a new one was asked for. */
  resumed: boolean
  greeting: string | null
  /** Hours since the previous conversation. */
  sinceLastDialogHours: number | null
  /** How many messages the returned dialog holds: 0 for a new or an empty one. */
  messageCount: number
  /** When the returned dialog last moved (its last message or its end), ISO; null if the agent did not say. */
  lastActivityAt: string | null
}
