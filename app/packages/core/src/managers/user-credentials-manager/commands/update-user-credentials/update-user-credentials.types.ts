export enum UpdateUserCredentialsCommandErrorCode {
  CREDENTIALS_NOT_FOUND = 'CREDENTIALS_NOT_FOUND',
}

export type UpdateUserCredentialsCommandResult =
  { success: true } | { success: false; error: UpdateUserCredentialsCommandErrorCode }
