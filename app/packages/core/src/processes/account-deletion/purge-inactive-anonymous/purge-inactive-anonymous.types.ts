/** No refusal to react to: an account that cannot be erased now is simply tried again on the next run. */
export interface PurgeInactiveAnonymousResult {
  success: true
  /** Accounts erased in this run. */
  purged: number
  /** Accounts left for the next run because the agent could not erase its copy. */
  failed: number
}
