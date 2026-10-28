import { sql } from 'drizzle-orm'
import { check, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core'
import { VOICE_PIPELINES, type VoicePipeline } from './types'

/**
 * The voice pipeline an admin picked for new conversations: a single row (`id = 1`), or none while nobody has picked.
 * One typed row rather than a key-value table: the product has no feature flags, and this is one product setting.
 * The agent learns the pipeline from every dialog start, so a change needs neither a deploy nor a restart.
 */
export const voiceSettings = pgTable(
  'voice_settings',
  {
    id: smallint('id').primaryKey().default(1),
    pipeline: text('pipeline').$type<VoicePipeline>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Admins are not users (rights come from ADMIN_EMAILS), so this is the address of whoever picked it. */
    updatedBy: text('updated_by').notNull(),
  },
  (t) => [
    check('voice_settings_single_row', sql`${t.id} = 1`),
    check('voice_settings_pipeline_check', sql.raw(`pipeline in (${VOICE_PIPELINES.map((p) => `'${p}'`).join(', ')})`)),
  ],
)

export type VoiceSettingsRow = typeof voiceSettings.$inferSelect
