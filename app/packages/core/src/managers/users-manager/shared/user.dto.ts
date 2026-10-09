import type { AgentVoice, UserRow } from '@ryadom/db/schema'

export interface UserDTO {
  id: string
  /** null for an anonymous account that has not linked an address yet. */
  email: string | null
  /** null only for a deleted account (anonymization). */
  name: string | null
  /** The voice the agent speaks with, by gender. */
  agentVoice: AgentVoice
  /** false means the account was blocked by an admin, or deleted. */
  isActive: boolean
  isEmailConfirmed: boolean
  isDeleted: boolean
  deletedAt: Date | null
  /** The last sign-in, session refresh or conversation; what the retention of anonymous accounts counts from. */
  lastActiveAt: Date
  createdAt: Date
  updatedAt: Date
}

export type UserSearchSortBy = 'createdAt' | 'email' | 'name'
export type SortOrder = 'asc' | 'desc'

/** Key under `users.properties` that holds the personal data archive of a deleted account. */
export const DELETION_ARCHIVE_KEY = 'deletion'

export function toUserDTO(row: UserRow): UserDTO {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    agentVoice: row.agentVoice,
    isActive: row.isActive,
    isEmailConfirmed: row.isEmailConfirmed,
    isDeleted: row.isDeleted,
    deletedAt: row.deletedAt,
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
