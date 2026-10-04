import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'

/**
 * A device that signs in without an email: how an anonymous account is found again. The app makes
 * `device_id` and a secret key on first launch and keeps both; the key proves the device is the one
 * that made the account.
 *
 * `key_hash` is a plain SHA-256: the key is 256 random bits made by the app, so there is nothing to
 * guess and nothing for a slow hash to protect, and a slow hash on a route that anyone can call
 * would only be a way to burn the server's CPU.
 */
export const userDevices = pgTable(
  'user_devices',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull().unique('user_devices_device_id_unique'),
    keyHash: text('key_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('user_devices_user_id_idx').on(t.userId)],
)

export type UserDeviceRow = typeof userDevices.$inferSelect
