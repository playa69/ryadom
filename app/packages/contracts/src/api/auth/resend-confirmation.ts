/**
 * `POST /api/auth/resend-confirmation` — another email confirmation code. Unauthenticated, because
 * signing in before confirmation is impossible, and with a uniform response, a success with `null`,
 * that does not reveal whether such an account exists. A missing email is a 400.
 */
export interface ResendConfirmationApiRequest {
  email: string
}
