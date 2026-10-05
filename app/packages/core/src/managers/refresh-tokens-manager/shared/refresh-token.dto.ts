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
  clientId: string | null
  userAgent: string | null
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
    clientId: row.clientId,
    userAgent: row.userAgent,
    createdAt: row.createdAt,
  }
}

/** One live session of a person, as the list of their devices shows it: a whole chain of tokens as one row. */
export interface SessionDTO {
  sessionId: string
  /** What the client called itself in `x-client-id` the last time it refreshed. */
  clientId: string | null
  userAgent: string | null
  /** When the person signed in. */
  startedAt: Date
  /** The latest refresh, so at most 15 minutes behind the person's last request. */
  lastUsedAt: Date
}
