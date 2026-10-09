export enum UpdateUserVoiceCommandErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
}

export type UpdateUserVoiceCommandResult =
  { success: true } | { success: false; error: UpdateUserVoiceCommandErrorCode }
