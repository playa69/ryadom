import { createDb } from '@ryadom/db'
import { runMigrations } from '@ryadom/db/migrate'

/**
 * A clean schema before the run: the tables and the migration journal are dropped and the
 * migrations are applied from scratch. That keeps the test database independent of whatever was
 * left over from previous runs.
 */
export async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL_TEST_API ?? 'postgres://ryadom:ryadom@localhost:55433/ryadom_test_api'
  const { sql, close } = createDb(url, { max: 1, applicationName: 'ryadom-api-tests' })
  try {
    await sql.unsafe('drop schema if exists drizzle cascade')
    const tables = await sql<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`
    for (const { tablename } of tables) await sql.unsafe(`drop table if exists "public"."${tablename}" cascade`)
  } finally {
    await close()
  }
  await runMigrations({ url })
}
