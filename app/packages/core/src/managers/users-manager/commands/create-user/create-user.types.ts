export enum CreateUserCommandErrorCode {
  USER_ALREADY_EXISTS = 'USER_ALREADY_EXISTS',
}

export type CreateUserCommandResult =
  { success: true } | { success: false; error: CreateUserCommandErrorCode }
