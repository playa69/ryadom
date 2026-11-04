/** Result of an action on a user card; shown above the buttons. */
export interface UserActionState {
  ok: string | null
  error: string | null
}

export const INITIAL_USER_ACTION_STATE: UserActionState = { ok: null, error: null }

/** Result of sending a notification: the line above the form, an error under a field, what was typed. */
export interface NotificationFormState {
  ok: string | null
  error: string | null
  fieldErrors: { title?: string; body?: string }
  /** Kept on a failure, so that the text is not lost; empty after a success. */
  values: { title: string; body: string }
}

export const INITIAL_NOTIFICATION_FORM_STATE: NotificationFormState = {
  ok: null,
  error: null,
  fieldErrors: {},
  values: { title: '', body: '' },
}

/** A device with notifications on, as the card shows it: nothing of its token. */
export interface NotificationDeviceView {
  id: string
  label: string
  updatedAt: string
}
