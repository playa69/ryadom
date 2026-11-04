import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import { PUSH_CHANNELS, type PushChannel } from './types'

/**
 * A device that agreed to receive notifications: the address a push service delivers to (`token`) and who it belongs
 * to. A token names one installation of the app, so it is unique per channel, and a second registration of it moves
 * the row to the account and session that registered it last (somebody else signed in on that phone).
 *
 * The row belongs to a session, not only to an account: nothing is sent to it once that session has ended (signing
 * out, ending the session from the list of devices, blocking, deletion), and that holds even when the device could not
 * tell the server it was leaving. There is no foreign key to the session: `refresh_tokens.session_id` is not unique.
 *
 * `project_id` is the push project the app was built for (RuStore keeps one per package and signature), so the server
 * knows which service token to send with; `app_id` is the package, so the admin panel can tell a release build from a
 * dev one.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    channel: text('channel').$type<PushChannel>().notNull(),
    token: text('token').notNull(),
    projectId: text('project_id').notNull(),
    appId: text('app_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('push_subscriptions_channel_token_unique').on(t.channel, t.token),
    index('push_subscriptions_user_id_idx').on(t.userId),
    index('push_subscriptions_session_id_idx').on(t.sessionId),
    check(
      'push_subscriptions_channel_check',
      sql.raw(`channel in (${PUSH_CHANNELS.map((c) => `'${c}'`).join(', ')})`),
    ),
  ],
)

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect
