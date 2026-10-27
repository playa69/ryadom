import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
// With the extension: vitest loads its config natively, and Node does not resolve a bare ./migrate.
import { defaultMigrationsFolder, runMigrations } from './migrate.ts'

/**
 * A database of its own for every run of the unit tests.
 *
 * The tests used to share two fixed databases on the development server, and their
 * global setup dropped every table in them: two agents testing at the same time wiped each other's data. Now a
 * run creates `ryadom_test_<stand>_<pid>` from a template that already holds the migrated schema, and drops it at
 * the end. The template (`ryadom_tpl_<hash of the migrations>`) is built once per set of migrations, under an
 * advisory lock, so a run costs a `CREATE DATABASE ... TEMPLATE` (a second) instead of a migration of its own.
 *
 * Which server: TEST_DB_ADMIN_URL, else the stand pinned in app/.stand.json (scripts/stand.mjs; `pnpm test` sets
 * the variable), else the old development server on 55433. There is no way to name the test database itself: a
 * fixed name would bring back the shared database the runs used to wipe.
 */

const APP_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const LEGACY_ADMIN_URL = 'postgres://ryadom:ryadom@localhost:55433/postgres'
const LOCK_NAME = 'ryadom:test-template'
const READY = 'ryadom-test-template'
const KEEP_TEMPLATES = 5

export interface TestDatabase {
  /** What the tests connect to. */
  url: string
  /** The database created for this run. */
  name: string
  /** The maintenance database of the same server, where databases are created from. */
  adminUrl: string
}

/** The stand id: STAND_ID, else the name of the worktree folder, as scripts/stand-ports.mjs computes it. */
function standSlug(): string {
  const pin = readPin()
  const raw = process.env.STAND_ID || pin?.id || basename(dirname(APP_ROOT))
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return (id || 'stand').slice(0, 30)
}

function readPin(): { id?: string; databases?: { admin?: string } } | null {
  try {
    return JSON.parse(readFileSync(join(APP_ROOT, '.stand.json'), 'utf8'))
  } catch {
    return null
  }
}

function adminUrl(): string {
  if (process.env.TEST_DB_ADMIN_URL) return process.env.TEST_DB_ADMIN_URL
  const pin = readPin()
  // Only the pin of the default identity: another STAND_ID in the same worktree has no pin of its own.
  if (pin?.databases?.admin && (!process.env.STAND_ID || process.env.STAND_ID === pin.id))
    return pin.databases.admin
  return LEGACY_ADMIN_URL
}

function withDatabase(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

/** Where this process's tests run. Deterministic per process, so the vitest config and its global setup agree on it. */
export function testDatabase(): TestDatabase {
  const admin = adminUrl()
  const name = `ryadom_test_${standSlug()}_${process.pid}`
  return { url: withDatabase(admin, name), name, adminUrl: admin }
}

/** Hash of the migration files: the template is rebuilt exactly when the schema may have changed. */
function migrationsHash(folder: string): string {
  const hash = createHash('sha256')
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else
        hash.update(
          `${relative(folder, path).replaceAll('\\', '/')}\0${readFileSync(path, 'utf8').replaceAll('\r\n', '\n')}\0`,
        )
    }
  }
  walk(folder)
  return hash.digest('hex').slice(0, 8)
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The server may be a container that is still starting: wait for it instead of failing the whole run. */
async function waitForServer(admin: postgres.Sql, url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await admin`select 1`
      return
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `PostgreSQL for the tests does not answer at ${new URL(url).host} (${(error as Error).message}). Start it with: pnpm stand:up --infra-only`,
        )
      }
      await sleep(500)
    }
  }
}

async function ensureTemplate(admin: postgres.Sql, adminConnection: string): Promise<string> {
  const template = `ryadom_tpl_${migrationsHash(defaultMigrationsFolder())}`
  const [row] = await admin<
    { comment: string | null }[]
  >`select shobj_description(oid, 'pg_database') as comment from pg_database where datname = ${template}`
  if (row?.comment?.startsWith(READY)) return template
  // A template that was never finished (the run that built it died): start over.
  if (row) await admin.unsafe(`drop database ${quote(template)} with (force)`)
  await admin.unsafe(`create database ${quote(template)}`)
  await runMigrations({ url: withDatabase(adminConnection, template) })
  await admin.unsafe(`comment on database ${quote(template)} is '${READY}:${Date.now()}'`)
  return template
}

/** Old templates (other branches, older migrations) go, newest few stay: worktrees with different migrations would otherwise rebuild each time. */
async function pruneTemplates(admin: postgres.Sql, current: string): Promise<void> {
  const rows = await admin<{ datname: string; comment: string | null }[]>`
    select datname, shobj_description(oid, 'pg_database') as comment from pg_database where datname like ${'ryadom\\_tpl\\_%'}`
  const stamp = (comment: string | null) => Number(comment?.split(':')[1] ?? 0)
  const old = rows
    .filter((row) => row.datname !== current)
    .sort((a, b) => stamp(b.comment) - stamp(a.comment))
    .slice(KEEP_TEMPLATES - 1)
  for (const row of old)
    await admin.unsafe(`drop database if exists ${quote(row.datname)} with (force)`).catch(() => {})
}

/** Databases of earlier runs of this stand whose process is gone: a run killed before its teardown leaves one behind. */
async function sweepOrphans(admin: postgres.Sql): Promise<void> {
  const rows = await admin<
    { datname: string }[]
  >`select datname from pg_database where datname like ${`ryadom\\_test\\_${standSlug()}\\_%`}`
  for (const { datname } of rows) {
    const pid = Number(datname.slice(datname.lastIndexOf('_') + 1))
    if (!Number.isInteger(pid) || pid === process.pid || isAlive(pid)) continue
    await admin.unsafe(`drop database if exists ${quote(datname)} with (force)`).catch(() => {})
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Creates the database of this run. Returns the function that drops it, for vitest's globalSetup to hand back as teardown. */
export async function prepareTestDatabase(database: TestDatabase): Promise<() => Promise<void>> {
  const admin = postgres(database.adminUrl, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: 'ryadom-test-db' },
  })
  try {
    await waitForServer(admin, database.adminUrl)
    // Session-level lock on this one connection; it is released with the connection if the run dies.
    await admin`select pg_advisory_lock(hashtext(${LOCK_NAME}))`
    const template = await ensureTemplate(admin, database.adminUrl)
    await sweepOrphans(admin)
    await admin.unsafe(`create database ${quote(database.name)} template ${quote(template)}`)
    await pruneTemplates(admin, template)
  } finally {
    await admin.end({ timeout: 5 })
  }
  return () => dropTestDatabase(database)
}

export async function dropTestDatabase(database: TestDatabase): Promise<void> {
  const admin = postgres(database.adminUrl, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`drop database if exists ${quote(database.name)} with (force)`)
  } catch (error) {
    process.stderr.write(`could not drop the test database ${database.name}: ${(error as Error).message}\n`)
  } finally {
    await admin.end({ timeout: 5 })
  }
}
