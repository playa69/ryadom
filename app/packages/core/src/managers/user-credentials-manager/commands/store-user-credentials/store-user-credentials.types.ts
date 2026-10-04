export enum StoreUserCredentialsCommandErrorCode {
  CREDENTIALS_ALREADY_EXIST = 'CREDENTIALS_ALREADY_EXIST',
}

export type StoreUserCredentialsCommandResult =
  { success: true } | { success: false; error: StoreUserCredentialsCommandErrorCode }
