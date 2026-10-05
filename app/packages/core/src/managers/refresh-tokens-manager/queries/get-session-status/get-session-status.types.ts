export interface GetSessionStatusQueryResult {
  success: true
  /** False once the session was signed out or revoked, or when the registry has never heard of it. */
  active: boolean
}
