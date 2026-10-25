import postgres from 'postgres'

/**
 * Marked days of the mood diary, written straight to the table: the API takes only today and yesterday
 * (design D2), so a marked week for the summary scenario has to be made another way. The database is the
 * one `scripts/stack.mjs` starts.
 */

const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://ryadom:ryadom@127.0.0.1:55434/ryadom'

export interface SeedMark {
  date: string
  mood: 1 | 2 | 3 | 4 | 5
  factor?: 'work' | 'people' | 'health' | 'money' | 'sleep' | null
}

export async function seedMarks(userId: string, marks: SeedMark[]): Promise<void> {
  const sql = postgres(DB_URL, { max: 1 })
  try {
    for (const { date, mood, factor = null } of marks) {
      await sql`
        insert into mood_checkins (user_id, local_date, mood, factor, source)
        values (${userId}, ${date}, ${mood}, ${factor}, 'app')
        on conflict (user_id, local_date) do update set mood = excluded.mood, factor = excluded.factor, updated_at = now()`
    }
  } finally {
    await sql.end()
  }
}
