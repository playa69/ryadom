import { index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

/** The score of one subscale of a result (`label` is for the screen, `id` for the code). */
export interface SelfCheckSubscale {
  id: string
  label: string
  score: number
}

/**
 * One saved result of a test inside the app (`REQ-WELL-06`…`08`, `openspec/specs/self-check`, D5).
 * Only the score, the scores of the subscales, the level and the time: the answers are never stored. A result is
 * a fact about health: it is shown to the person alone and the agent does not read it.
 */
export const selfCheckResults = pgTable(
  'self_check_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    testId: text('test_id').notNull(),
    testVersion: integer('test_version').notNull(),
    score: numeric('score', { precision: 6, scale: 2, mode: 'number' }).notNull(),
    subscores: jsonb('subscores').$type<SelfCheckSubscale[]>(),
    band: text('band').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('self_check_results_user_test_taken_idx').on(t.userId, t.testId, t.takenAt.desc())],
)

export type SelfCheckResultRow = typeof selfCheckResults.$inferSelect

/** What a person did with the consent to keep results: `granted` after the consent sheet, `revoked` when they withdrew it. */
export type SelfCheckConsentAction = 'granted' | 'revoked'

/**
 * Every time a person agreed to keep their test results (`granted`) or withdrew that (`revoked`), with the date: the
 * same journal as `memory_consent_events` has for memory. `user_consents` holds the first acceptance of each version and
 * cannot say "withdrawn"; this journal is the rest of the story, so it can be shown when consent was in force and when
 * it was not. Whether results may be kept right now is the latest row.
 *
 * Append-only and without texts: an id, an action, the version of the consent sheet and a time. Like `user_consents`,
 * it survives the account's deletion (the user row is only anonymized).
 */
export const selfCheckConsentEvents = pgTable(
  'self_check_consent_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    action: text('action').$type<SelfCheckConsentAction>().notNull(),
    version: text('version').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('self_check_consent_events_user_id_idx').on(t.userId, t.at)],
)
