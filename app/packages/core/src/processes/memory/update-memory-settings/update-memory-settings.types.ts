import type { MemorySettingsDTO } from '../shared/memory.dto'

export enum UpdateMemorySettingsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** Turning memory on without accepting the consent sheet (or without its version): nothing is recorded. */
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
  /** Memory is unavailable on the server: it cannot be turned on now. The consent stays on record. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
  /** A closed beta, and this person is not in it. The consent stays on record. */
  MEMORY_NOT_ALLOWED = 'MEMORY_NOT_ALLOWED',
}

export type UpdateMemorySettingsResult =
  | { success: true; settings: MemorySettingsDTO }
  | { success: false; error: UpdateMemorySettingsOperationErrorCode }
