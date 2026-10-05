import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import type { UserConsentKind } from './types'

/**
 * What a person agreed to and when, one row per kind and version. Accepting a new version of the
 * terms adds rows and leaves the old ones: the record has to show what was agreed to at the time.
 *
 * It survives the account's deletion (the user row is only anonymized): it is the evidence that the
 * data was processed with consent.
 */
export const userConsents = pgTable(
  'user_consents',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<UserConsentKind>().notNull(),
    /** The version of the terms that was on screen, a date such as `2026-10-04`. */
    version: text('version').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('user_consents_user_kind_version_unique').on(t.userId, t.kind, t.version),
    index('user_consents_user_id_idx').on(t.userId),
  ],
)

export type UserConsentRow = typeof userConsents.$inferSelect
