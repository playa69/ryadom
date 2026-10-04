/**
 * Sign-in responses. This is our own API contract: core DTOs never leave the server and fields are
 * listed by name, so a new column in the users table does not reach the app on its own.
 */

/**
 * The token pair: access for 15 minutes, refresh for 30 days. The app keeps the access
 * token in memory and the refresh token in the platform's secure storage.
 */
export interface AuthTokensApiResponse {
  accessToken: string
  refreshToken: string
  /** Unix time in milliseconds when the access token expires. */
  expiresAt: number
}

export interface AuthUserApiResponse {
  id: string
  /** null for an anonymous account that has not linked an address. */
  email: string | null
  name: string | null
}

export interface LoginApiResponse {
  user: AuthUserApiResponse
  tokens: AuthTokensApiResponse
}
