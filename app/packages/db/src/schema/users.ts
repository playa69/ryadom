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
    email: citext('email').notNull().unique('users_email_unique'),
    name: text('name'),
    isActive: boolean('is_active').notNull().default(true),
    isEmailConfirmed: boolean('is_email_confirmed').notNull().default(false),
    properties: jsonb('properties').$type<Record<string, unknown>>(),
    isDeleted: boolean('is_deleted').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_created_at_idx').on(t.createdAt), index('users_is_deleted_idx').on(t.isDeleted)],
)

export type UserRow = typeof users.$inferSelect
export type NewUserRow = typeof users.$inferInsert
