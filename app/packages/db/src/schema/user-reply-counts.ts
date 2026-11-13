import { date, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

/**
 * How many replies of the person the dialog gateway accepted, for the goals of Yandex Metrika: one row per account,
 * holding the count of its latest day (`day`, a calendar date in Moscow) and when its very first reply was accepted.
 *
 * The count lives on the server, not in a browser, because the goals are per account: the third reply of the day can
 * come from a second device, after a reload or a new sign-in. A row exists from the first reply on, so "first reply"
 * is the insert of the row. Accounts made before this table got a row with `replies = 0` and no `first_reply_at` when
 * it was created: they had talked already, or may have, and their next reply must not pass for a first one.
 *
 * Nothing here says what was said: only how much, and on which day.
 */
export const userReplyCounts = pgTable('user_reply_counts', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(),
  replies: integer('replies').notNull(),
  /** Null for an account that existed before the table: its first reply was never seen. */
  firstReplyAt: timestamp('first_reply_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type UserReplyCountRow = typeof userReplyCounts.$inferSelect
