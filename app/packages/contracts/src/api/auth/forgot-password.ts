/**
 * `POST /api/auth/forgot-password` — sends a password reset code by email.
 *
 * The response is always the same, a success with `null`, whether the account exists or not:
 * otherwise the form would become a way to check whether a person is registered. A missing email is
 * a 400.
 */
export interface ForgotPasswordApiRequest {
  email: string
}
