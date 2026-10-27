export enum ForgetMemoryFactOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The agent cannot forget right now (no disk): nothing was forgotten, try again. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
}

export type ForgetMemoryFactResult =
  { success: true } | { success: false; error: ForgetMemoryFactOperationErrorCode }
