import { sql } from 'drizzle-orm'
import {
  check,
  customType,
  date,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './users'

/** Where the mood note came from (`REQ-WELL-01`). */
export type MoodSource = 'app' | 'widget' | 'reminder' | 'telegram'
/** The one factor a person may name beside the mood. */
export type MoodFactor = 'work' | 'people' | 'health' | 'money' | 'sleep'
export type DiarySummaryKind = 'week'
/** `pending`: a replica has taken the period and the agent is writing; `ready`: the text is there (design D9). */
export type DiarySummaryStatus = 'pending' | 'ready'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

/**
 * One mood note per person per local day (`openspec/specs/mood-diary`, D11). `local_date` is the
 * day in the person's time zone, not UTC. A mood with the account id may count as health data: the
 * values never go to product analytics.
 */
export const moodCheckins = pgTable(
  'mood_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    localDate: date('local_date', { mode: 'string' }).notNull(),
    mood: smallint('mood').notNull(),
    factor: text('factor').$type<MoodFactor>(),
    source: text('source').$type<MoodSource>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('mood_checkins_user_date_unique').on(t.userId, t.localDate),
    check('mood_checkins_mood_check', sql`${t.mood} between 1 and 5`),
    check(
      'mood_checkins_factor_check',
      sql`${t.factor} is null or ${t.factor} in ('work', 'people', 'health', 'money', 'sleep')`,
    ),
    check('mood_checkins_source_check', sql`${t.source} in ('app', 'widget', 'reminder', 'telegram')`),
  ],
)

/** The agent writes the text, the app keeps it: the summary of a week of the diary. */
export const diarySummaries = pgTable(
  'diary_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<DiarySummaryKind>().notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    text: text('text').notNull(),
    status: text('status').$type<DiarySummaryStatus>().notNull().default('ready'),
    stats: jsonb('stats').$type<Record<string, unknown>>(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('diary_summaries_user_kind_period_unique').on(t.userId, t.kind, t.periodStart),
    check('diary_summaries_kind_check', sql`${t.kind} = 'week'`),
    check('diary_summaries_status_check', sql`${t.status} in ('pending', 'ready')`),
  ],
)

/** The limited token of the Android widget: it can read today's mark and write one. Only the hash is stored. */
export const widgetTokens = pgTable(
  'widget_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: bytea('token_hash').notNull().unique('widget_tokens_token_hash_unique'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('widget_tokens_user_id_idx').on(t.userId)],
)

export type MoodCheckinRow = typeof moodCheckins.$inferSelect
export type DiarySummaryRow = typeof diarySummaries.$inferSelect
