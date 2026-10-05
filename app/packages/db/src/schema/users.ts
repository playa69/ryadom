import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { citext } from './types'

/**
 * Account. The password lives in `user_credentials`, and there are no external sign-in providers
 *. Blocking is `is_active = false`. Deletion is soft: the row is anonymized,
 * `is_deleted = true`, and the personal-data archive goes to `properties.deletion`.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null for an anonymous account that has not linked an address (Postgres lets many rows hold null in a unique column). */
    email: citext('email').unique('users_email_unique'),
    name: text('name'),
    isActive: boolean('is_active').notNull().default(true),
    isEmailConfirmed: boolean('is_email_confirmed').notNull().default(false),
    properties: jsonb('properties').$type<Record<string, unknown>>(),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /**
     * The last time the person was seen: a sign-in, a session refresh or a conversation. An anonymous
     * account that nobody has opened for long enough is erased.
     */
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('users_created_at_idx').on(t.createdAt),
    index('users_is_deleted_idx').on(t.isDeleted),
    index('users_last_active_at_idx').on(t.lastActiveAt),
  ],
)

export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
