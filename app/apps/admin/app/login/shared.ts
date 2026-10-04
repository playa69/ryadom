/** Shared by the login action and the form; the form is a client component. */
export interface LoginFormState {
  step: 'email' | 'code'
  email: string
  error: string | null
}

export const INITIAL_LOGIN_STATE: LoginFormState = { step: 'email', email: '', error: null }
