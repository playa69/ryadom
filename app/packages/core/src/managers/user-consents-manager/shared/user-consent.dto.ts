import type { UserConsentKind, UserConsentRow } from '@ryadom/db/schema'

/** One thing a person agreed to, in one version of the terms. */
export interface UserConsentDTO {
  id: string
  userId: string
  kind: UserConsentKind
  version: string
  acceptedAt: Date
}

export function toUserConsentDTO(row: UserConsentRow): UserConsentDTO {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    version: row.version,
    acceptedAt: row.acceptedAt,
  }
}
