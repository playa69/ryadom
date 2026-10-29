import { index, integer, jsonb, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

/** The score of one subscale of a result (`label` is for the screen, `id` for the code). */
export interface SelfCheckSubscale {
  id: string
  label: string
  score: number
}

/**
 * One saved result of a test inside the app (`REQ-WELL-06`…`08`, `openspec/changes/add-self-check-tests`, D5).
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
