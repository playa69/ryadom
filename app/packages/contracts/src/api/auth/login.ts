/**
 * `POST /api/auth/login` — sign in with email and password; the response is `LoginApiResponse`.
 *
 * The route has no coded rules: every failure is a bare 401. The reason must not be named, because
 * "confirm your email" confirms that the address is registered. The real reason goes to the log, and
 * the login screen lists all the cases at once under "Can't sign in?".
 */
export interface LoginApiRequest {
  email: string
  password: string
}
