import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import type { MemoryConsentAction } from './types'

/**
 * Every time a person turned the agent's memory on (`granted`, after the consent sheet) or off
 * (`revoked`), with the date. `user_consents` holds the first acceptance of each version and cannot
 * say "withdrawn"; this journal is the rest of the story, so that it can be shown when consent was
 * in force and when it was not.
 *
 * Append-only and without texts: a row is an id, an action, the version of the sheet and a time.
 * Whether memory is on right now is the agent's to say; this is the evidence of what the person did.
 *
 * Like `user_consents`, it survives the account's deletion (the user row is only anonymized).
 */
export const memoryConsentEvents = pgTable(
  'memory_consent_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: text('action').$type<MemoryConsentAction>().notNull(),
    /** The version of the memory sheet: the one accepted for `granted`, the latest one accepted for `revoked`. */
    version: text('version').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_consent_events_user_id_idx').on(t.userId, t.at)],
)

export type MemoryConsentEventRow = typeof memoryConsentEvents.$inferSelect
