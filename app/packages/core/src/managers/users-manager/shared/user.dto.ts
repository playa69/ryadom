import type { UserRow } from '@ryadom/db/schema'

export interface UserDTO {
  id: string
  email: string
  /** null only for a deleted account (anonymization). */
  name: string | null
  /** false means the account was blocked by an admin, or deleted. */
  isActive: boolean
  isEmailConfirmed: boolean
  isDeleted: boolean
  deletedAt: Date | null
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
    isActive: row.isActive,
    isEmailConfirmed: row.isEmailConfirmed,
    isDeleted: row.isDeleted,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
