export enum ForgetMemoryFactOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** The agent cannot forget right now (no disk): nothing was forgotten, try again. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** The agent cannot forget a single fact (Cognee keeps none): the person can forget everything. */
  UNSUPPORTED = 'UNSUPPORTED',
}

export type ForgetMemoryFactResult =
  { success: true } | { success: false; error: ForgetMemoryFactOperationErrorCode }
