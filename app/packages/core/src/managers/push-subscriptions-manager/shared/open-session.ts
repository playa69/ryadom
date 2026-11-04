import { and, eq, gt, inArray, sql, type SQL } from 'drizzle-orm'
import { pushSubscriptions, refreshTokens } from '@ryadom/db/schema'
import { getDb } from '../../../shared'

/**
 * The session of a subscription is open: one of its refresh tokens is still good, and none was ended by signing out or
 * revoking. Rotated tokens count as good until their expiry, so the moment between retiring a token and registering
 * its successor does not look like an ended session (`GetSessionStatusQuery` judges it the same way).
 */
export function sessionIsOpen(now: Date): SQL {
  const db = getDb()
  const live = db
    .select({ one: sql`1` })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.sessionId, pushSubscriptions.sessionId), gt(refreshTokens.expiresAt, now)))
  const ended = db
    .select({ one: sql`1` })
    .from(refreshTokens)
    .where(
      and(
        eq(refreshTokens.sessionId, pushSubscriptions.sessionId),
        inArray(refreshTokens.revokedReason, ['signed_out', 'revoked']),
      ),
    )
  return sql`(exists ${live} and not exists ${ended})`
}
