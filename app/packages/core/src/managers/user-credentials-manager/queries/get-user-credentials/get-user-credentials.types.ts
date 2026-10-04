import type { UserCredentialsDTO } from '../../shared/user-credentials.dto'

export enum GetUserCredentialsQueryErrorCode {
  CREDENTIALS_NOT_FOUND = 'CREDENTIALS_NOT_FOUND',
}

export type GetUserCredentialsQueryResult =
  { success: true; credentials: UserCredentialsDTO } | { success: false; error: GetUserCredentialsQueryErrorCode }
