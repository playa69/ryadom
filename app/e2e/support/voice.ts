import postgres from 'postgres'
import type { VoicePipeline } from '@ryadom/contracts/voices'
import { DATABASE_URL } from '../playwright.config'

/**
 * The voice path as the admin console leaves it, written straight to its table: the stand runs no console, and the
 * profile shows the voices of the path. `null` removes the row, which is the default path (Sber). The tests run one at
 * a time, so a test that sets a path puts the default back when it is done.
 */
export async function setVoicePipeline(pipeline: VoicePipeline | null): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1 })
  try {
    if (pipeline === null) {
      await sql`delete from voice_settings`
    } else {
      await sql`
        insert into voice_settings (id, pipeline, updated_at, updated_by) values (1, ${pipeline}, now(), 'e2e@example.com')
        on conflict (id) do update set pipeline = excluded.pipeline, updated_at = excluded.updated_at`
    }
  } finally {
    await sql.end()
  }
}
