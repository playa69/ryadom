import type { RefreshTokenRevokeReason, RefreshTokenRow } from '@ryadom/db/schema'

/** A registered refresh token. Core-internal type: the token itself never reaches the core. */
export interface RefreshTokenDTO {
  id: string
  /** The session the token belongs to; the same for the whole chain of rotations. */
  sessionId: string
  userId: string
  expiresAt: Date
  /** When the token was retired (used, signed out, or revoked); null while it is active. */
  revokedAt: Date | null
  /** Why it was retired; null while it is active. */
  revokedReason: RefreshTokenRevokeReason | null
  createdAt: Date
}

export function toRefreshTokenDTO(row: RefreshTokenRow): RefreshTokenDTO {
  return {
    id: row.id,
    sessionId: row.sessionId,
    userId: row.userId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    createdAt: row.createdAt,
  }
}
