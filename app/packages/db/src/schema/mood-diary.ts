import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { users } from './users'

/** Where the mood note came from (`REQ-WELL-01`). */
export type MoodSource = 'app' | 'widget' | 'reminder' | 'telegram'
/** The one factor a person may name beside the mood. */
export type MoodFactor = 'work' | 'people' | 'health' | 'money' | 'sleep'
export type DiarySummaryKind = 'week' | 'year'
export type PushChannel = 'web_push' | 'telegram' | 'native_local'

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' })

/**
 * One mood note per person per local day (`openspec/changes/add-mood-diary`, D11). `local_date` is the
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

/** The agent writes the text, the app keeps it: a week or a year story of the diary. */
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
    stats: jsonb('stats').$type<Record<string, unknown>>(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('diary_summaries_user_kind_period_unique').on(t.userId, t.kind, t.periodStart),
    check('diary_summaries_kind_check', sql`${t.kind} in ('week', 'year')`),
  ],
)

/** Reminder settings; a row appears with the first change, the defaults hold until then. */
export const notificationSettings = pgTable('notification_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  moodReminderEnabled: boolean('mood_reminder_enabled').notNull().default(true),
  moodReminderTime: time('mood_reminder_time').notNull().default('20:00'),
  /** Set after 7 reminders in a row went unopened; cleared by opening the app. */
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  /** Unopened reminders are counted from here: "Return" on a paused reminder moves it to now. */
  streakResetAt: timestamp('streak_reset_at', { withTimezone: true }),
  /** The person answered the "remind in the evening?" question, either way. */
  offerAnsweredAt: timestamp('offer_answered_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

/** A device or chat the reminder may reach. Web Push keeps the browser's endpoint and keys. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text('channel').$type<PushChannel>().notNull(),
    endpoint: text('endpoint'),
    p256dh: text('p256dh'),
    auth: text('auth'),
    deviceLabel: text('device_label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    failures: integer('failures').notNull().default(0),
  },
  (t) => [
    index('push_subscriptions_user_id_idx').on(t.userId),
    check('push_subscriptions_channel_check', sql`${t.channel} in ('web_push', 'telegram', 'native_local')`),
  ],
)

/** One delivery per person, kind and local day: the unique key is what keeps replicas from sending twice. */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    localDate: date('local_date', { mode: 'string' }).notNull(),
    channel: text('channel').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [unique('notification_deliveries_user_kind_date_unique').on(t.userId, t.kind, t.localDate)],
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
