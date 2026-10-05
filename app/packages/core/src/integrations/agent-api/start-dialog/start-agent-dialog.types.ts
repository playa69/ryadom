export interface StartAgentDialogResponse {
  dialogId: string
  /** true means an already open dialog was returned instead of a new one. */
  resumed: boolean
  greeting: string | null
  /** Hours since the previous conversation. */
  sinceLastDialogHours: number | null
}
