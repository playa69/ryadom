import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

/** pg_advisory_lock key: only one process per database applies migrations at a time. */
const LOCK_NAME = 'ryadom:migrations'
const LOCK_POLL_MS = 1000

export interface RunMigrationsOptions {
  url: string
  /** Folder with the SQL files and meta/_journal.json. Located next to the module by default (see defaultMigrationsFolder). */
  migrationsFolder?: string
  /** How long to wait for someone else's lock before giving up, 5 minutes by default. */
  lockTimeoutMs?: number
  log?: (message: string) => void
}

export interface RunMigrationsResult {
  /** Tags of the migrations applied by this run; empty means the schema was already up to date. */
  applied: string[]
  /** Total number of migrations in the journal. */
  total: number
}

interface JournalEntry {
  idx: number
  when: number
  tag: string
}

/**
 * Migrations folder: MIGRATIONS_DIR, then `./migrations` next to the bundle (the migrate image),
 * then `../migrations` relative to src/ (running from sources).
 */
export function defaultMigrationsFolder(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    fileURLToPath(new URL('./migrations', import.meta.url)),
    fileURLToPath(new URL('../migrations', import.meta.url)),
    fileURLToPath(new URL('../../migrations', import.meta.url)),
  ].filter((candidate): candidate is string => Boolean(candidate))
  const found = candidates.find((dir) => existsSync(join(dir, 'meta', '_journal.json')))
  if (!found) throw new Error(`Migrations folder not found, looked in: ${candidates.join(', ')}`)
  return found
}

function readJournal(folder: string): JournalEntry[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[]
  }
  return journal.entries
}

async function appliedTimestamps(sql: postgres.Sql): Promise<Set<number>> {
  const [exists] = await sql<{ exists: boolean }[]>`
    select to_regclass('drizzle.__drizzle_migrations') is not null as exists
  `
  if (!exists?.exists) return new Set()
  const rows = await sql<{ created_at: string }[]>`select created_at from drizzle.__drizzle_migrations`
  return new Set(rows.map((row) => Number(row.created_at)))
}

/**
 * Applies migrations under a pg_advisory_lock held on a separate connection: if the process dies,
 * that connection closes and the lock is released on its own. Every error is thrown and nothing is
 * swallowed, because the migrate container must exit non-zero.
 */
export async function runMigrations(opts: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const log = opts.log ?? (() => {})
  const folder = opts.migrationsFolder ?? defaultMigrationsFolder()
  const journal = readJournal(folder)
  const lockTimeoutMs = opts.lockTimeoutMs ?? 5 * 60 * 1000

  const lockSql = postgres(opts.url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: 'ryadom-migrate-lock' },
  })
  const migrateSql = postgres(opts.url, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: 'ryadom-migrate' },
  })
  try {
    const started = Date.now()
    for (let attempt = 0; ; attempt++) {
      const [row] = await lockSql<
        { locked: boolean }[]
      >`select pg_try_advisory_lock(hashtext(${LOCK_NAME})) as locked`
      if (row?.locked) break
      if (Date.now() - started > lockTimeoutMs) {
        throw new Error(
          `Could not acquire migration lock in ${lockTimeoutMs} ms: another migration is running`,
        )
      }
      if (attempt === 0) log('Another migration holds the lock, waiting...')
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
    }

    try {
      const before = await appliedTimestamps(migrateSql)
      await migrate(drizzle({ client: migrateSql }), { migrationsFolder: folder })
      const after = await appliedTimestamps(migrateSql)
      const applied = journal
        .filter((entry) => after.has(entry.when) && !before.has(entry.when))
        .map((entry) => entry.tag)
      return { applied, total: journal.length }
    } finally {
      await lockSql`select pg_advisory_unlock(hashtext(${LOCK_NAME}))`
    }
  } finally {
    await Promise.allSettled([lockSql.end({ timeout: 5 }), migrateSql.end({ timeout: 5 })])
  }
}
