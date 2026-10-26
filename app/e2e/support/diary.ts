import postgres from 'postgres'

/**
 * Marked days of the mood diary, written straight to the table: the API takes only today and yesterday
 * (design D2), so a marked week for the summary scenario has to be made another way. The database is the
 * one `scripts/stack.mjs` starts. The notes look written ten minutes ago, so the quiet minute that the
 * background pass waits after the last change is over for them.
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
        insert into mood_checkins (user_id, local_date, mood, factor, source, updated_at)
        values (${userId}, ${date}, ${mood}, ${factor}, 'app', now() - interval '10 minutes')
        on conflict (user_id, local_date) do update set mood = excluded.mood, factor = excluded.factor, updated_at = excluded.updated_at`
    }
  } finally {
    await sql.end()
  }
}

/**
 * Makes the week text look written seven hours ago, so the six-hour gap of the background pass is over
 * (the text itself and the marks stay as they are).
 */
export async function ageWeekSummary(userId: string): Promise<void> {
  const sql = postgres(DB_URL, { max: 1 })
  try {
    await sql`
      update diary_summaries
      set stats = coalesce(stats, '{}'::jsonb) - 'writtenAt' - 'manualAt', generated_at = now() - interval '7 hours'
      where user_id = ${userId} and kind = 'week'`
  } finally {
    await sql.end()
  }
}

/** The agent mock's own address: the `seed` route fills a person's journal with ready-made conversations (dev only). */
const AGENT_URL = 'http://127.0.0.1:8081'

export interface SeedDialog {
  startedAt: string
  endedAt: string
  summary: Record<string, unknown> | null
  messages?: { role: 'user' | 'assistant'; text: string }[]
  /** `false`: a conversation the person asked not to keep: only the mark exists. */
  saved?: boolean
}

export async function seedDialogs(userId: string, dialogs: SeedDialog[]): Promise<void> {
  const response = await fetch(`${AGENT_URL}/v1/users/${userId}/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dialogs }),
  })
  if (!response.ok) throw new Error(`seed of dialogs failed: ${response.status}`)
}
