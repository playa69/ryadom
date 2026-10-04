/** Result of an action on a user card; shown above the buttons. */
export interface UserActionState {
  ok: string | null
  error: string | null
}

export const INITIAL_USER_ACTION_STATE: UserActionState = { ok: null, error: null }
