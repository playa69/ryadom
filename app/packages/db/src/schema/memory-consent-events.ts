import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import type { MemoryConsentAction } from './types'

/**
 * Every time a person accepted the memory consent (`granted`, after the consent sheet), paused
 * memory (`paused`) or turned it back on (`resumed`), with the date. A pause is not a withdrawal:
 * the consent stays in force. `revoked` is for the consent itself ending. `user_consents` holds the
 * first acceptance of each version; this journal is the rest of the story, so that it can be shown
 * when consent was in force and what the person did with the switch.
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
    /** The version of the memory sheet: the one accepted for `granted`, the latest one accepted for the other actions. */
    version: text('version').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_consent_events_user_id_idx').on(t.userId, t.at)],
)

export type MemoryConsentEventRow = typeof memoryConsentEvents.$inferSelect
