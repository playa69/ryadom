import type { MemoryConsentAction, MemoryConsentEventRow } from '@ryadom/db/schema'

/** One time a person turned the agent's memory on (`granted`) or off (`revoked`). */
export interface MemoryConsentEventDTO {
  id: string
  userId: string
  action: MemoryConsentAction
  /** The version of the memory consent sheet. */
  version: string
  at: Date
}

export function toMemoryConsentEventDTO(row: MemoryConsentEventRow): MemoryConsentEventDTO {
  return {
    id: row.id,
    userId: row.userId,
    action: row.action,
    version: row.version,
    at: row.at,
  }
}
