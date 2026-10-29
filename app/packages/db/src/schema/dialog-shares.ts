import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'

/**
 * A link to one conversation (`REQ-DATA-05`, `openspec/specs/dialog-share`).
 *
 * Neither the token nor a word of the conversation is stored here: the token is derived from `id`
 * with a server secret (so the owner can see the link again), `token_hash` is only how a visit finds
 * its row, and the texts stay with the agent, which reads them out at every visit up to
 * `up_to_message_id`. A person has one active link per dialog; an expired or revoked one is retired
 * by `revoked_at` before the next is made.
 */
export const dialogShares = pgTable(
  'dialog_shares',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dialogId: text('dialog_id').notNull(),
    /** SHA-256 of the token, hex. */
    tokenHash: text('token_hash').notNull().unique(),
    /** The last message the link shows; later ones are not part of what was shared. */
    upToMessageId: text('up_to_message_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
  },
  (t) => [
    index('dialog_shares_user_id_idx').on(t.userId),
    index('dialog_shares_expires_at_idx').on(t.expiresAt),
    uniqueIndex('dialog_shares_active_dialog_idx')
      .on(t.userId, t.dialogId)
      .where(sql`${t.revokedAt} is null`),
  ],
)

export type DialogShareRow = typeof dialogShares.$inferSelect
