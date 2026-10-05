import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { citext, type EmailCodePurpose } from './types'

/**
 * Codes sent by email: email confirmation, password reset, admin sign-in.
 * Deliberately not tied to `users`: the address may not be an account yet (the code confirms the
 * registration), and an admin is not a user at all.
 *
 * A pair of (email, purpose) has at most one live code, and a new request replaces the previous
 * one. A partial unique index over unused codes enforces that in the database, not only in code.
 */
export const emailCodes = pgTable(
  'email_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: citext('email').notNull(),
    purpose: text('purpose').$type<EmailCodePurpose>().notNull(),
    /** SHA-256 of the code (services/token-service), not the code itself. */
    codeHash: text('code_hash').notNull(),
    /** Consecutive wrong attempts; the fifth one burns the code (managers/email-codes-manager). */
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('email_codes_email_purpose_idx').on(t.email, t.purpose),
    uniqueIndex('email_codes_active_idx')
      .on(t.email, t.purpose)
      .where(sql`${t.usedAt} is null`),
  ],
)

export type EmailCodeRow = typeof emailCodes.$inferSelect
