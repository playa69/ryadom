export enum StoreRefreshTokenCommandErrorCode {
  TOKEN_ALREADY_EXISTS = 'TOKEN_ALREADY_EXISTS',
}

export type StoreRefreshTokenCommandResult =
  { success: true } | { success: false; error: StoreRefreshTokenCommandErrorCode }
