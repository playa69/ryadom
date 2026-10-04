import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { users } from './users'
import type { AuditLogAction } from './types'

/**
 * Log of admin actions. An admin is not a user (rights come only from the ADMIN_EMAILS list), so a
 * record holds their address. The user reference is `set null`, and the target address is kept as a
 * snapshot.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminEmail: text('admin_email').notNull(),
    action: text('action').$type<AuditLogAction>().notNull(),
    targetUserId: uuid('target_user_id').references(() => users.id, { onDelete: 'set null' }),
    targetEmail: text('target_email'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_created_at_idx').on(t.createdAt.desc()),
    index('audit_log_target_user_idx').on(t.targetUserId, t.createdAt.desc()),
  ],
)

export type AuditLogRow = typeof auditLog.$inferSelect
