import type { UserCredentialsRow } from '@ryadom/db/schema'

/**
 * Account password. Core-internal type: the hash is never handed out, applications only need to
 * know that a password exists.
 */
export interface UserCredentialsDTO {
  userId: string
  passwordHash: string
  createdAt: Date
  updatedAt: Date
}

export function toUserCredentialsDTO(row: UserCredentialsRow): UserCredentialsDTO {
  return {
    userId: row.userId,
    passwordHash: row.passwordHash,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}
