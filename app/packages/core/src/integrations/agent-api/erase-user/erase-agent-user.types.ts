export interface EraseAgentUserResponse {
  /** true means the agent no longer holds the data (204, or 404 when there was nothing to erase). */
  erased: boolean
}
