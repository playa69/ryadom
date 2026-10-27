import type { MemorySettingsDTO } from '../shared/memory.dto'

export enum UpdateMemorySettingsOperationErrorCode {
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  /** Turning memory on without accepting the consent sheet (or without its version): nothing is recorded. */
  CONSENT_REQUIRED = 'CONSENT_REQUIRED',
  /** Memory is unavailable on the server: it cannot be turned on now. The consent stays on record. */
  MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE',
}

export type UpdateMemorySettingsResult =
  | { success: true; settings: MemorySettingsDTO }
  | { success: false; error: UpdateMemorySettingsOperationErrorCode }
