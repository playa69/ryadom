import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import type { RefreshTokenRevokeReason } from './types'

/**
 * Register of the app's refresh tokens. The token itself is a signed JWT held by the client; this
 * row is what makes it revocable. `id` is the token's `jti` claim, so a token is looked up without
 * storing it (or a hash of it) anywhere.
 *
 * Each use of a token retires it (`revoked_at`, reason `rotated`) and registers its successor. A
 * retired token is kept until it would have expired anyway: presenting a rotated one after the grace
 * window is the sign of a stolen copy, and that is only recognizable while the row still exists.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    /** The session this token belongs to: the same for every token of one chain of rotations. */
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason').$type<RefreshTokenRevokeReason>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refresh_tokens_user_id_idx').on(t.userId),
    index('refresh_tokens_session_id_idx').on(t.sessionId),
    index('refresh_tokens_expires_at_idx').on(t.expiresAt),
  ],
)

export type RefreshTokenRow = typeof refreshTokens.$inferSelect
