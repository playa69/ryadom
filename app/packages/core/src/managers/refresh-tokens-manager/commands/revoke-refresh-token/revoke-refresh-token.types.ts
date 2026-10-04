export enum RevokeRefreshTokenCommandErrorCode {
  TOKEN_NOT_ACTIVE = 'TOKEN_NOT_ACTIVE',
}

export type RevokeRefreshTokenCommandResult =
  { success: true } | { success: false; error: RevokeRefreshTokenCommandErrorCode }
