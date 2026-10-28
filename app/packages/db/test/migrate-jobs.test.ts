import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultMigrationsFolder, runMigrations } from '../src/migrate'
import { migrationsHash, pgBossVersion, prepareTestDatabase, testDatabase } from '../src/test-db'

/**
 * `add-job-queue`: the migrator installs the job queue's schema (`pgboss`) after the drizzle
 * migrations, from the role that owns the database and has no superuser rights, like the `app` role in the cluster.
 */

const admin = testDatabase().adminUrl
const suffix = `${process.pid}_${randomBytes(3).toString('hex')}`
const ROLE = `ryadom_jobs_owner_${suffix}`
const PASSWORD = randomBytes(12).toString('hex')
const DATABASE = `ryadom_jobs_migrate_${suffix}`
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

let adminSql: postgres.Sql
let ownerUrl: string

function urlFor(user: string, password: string, database: string): string {
  const parsed = new URL(admin)
  parsed.username = user
  parsed.password = password
  parsed.pathname = `/${database}`
  return parsed.toString()
}

beforeAll(async () => {
  adminSql = postgres(admin, { max: 1, onnotice: () => {} })
  await adminSql.unsafe(
    `create role ${quote(ROLE)} login password '${PASSWORD}' nosuperuser nocreatedb nocreaterole`,
  )
  await adminSql.unsafe(`create database ${quote(DATABASE)} owner ${quote(ROLE)}`)
  ownerUrl = urlFor(ROLE, PASSWORD, DATABASE)
})

afterAll(async () => {
  await adminSql.unsafe(`drop database if exists ${quote(DATABASE)} with (force)`)
  await adminSql.unsafe(`drop role if exists ${quote(ROLE)}`)
  await adminSql.end({ timeout: 5 })
})

async function ownerQuery<T extends object>(text: string): Promise<T[]> {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} })
  try {
    return await sql.unsafe<T[]>(text)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

describe('схема очереди задач в мигратор', () => {
  it('роль без прав суперпользователя ставит схему pgboss на пустую базу', async () => {
    const [role] = await adminSql<
      { rolsuper: boolean }[]
    >`select rolsuper from pg_roles where rolname = ${ROLE}`
    expect(role?.rolsuper).toBe(false)

    const result = await runMigrations({ url: ownerUrl })

    expect(result.jobsSchema.changed).toBe(true)
    expect(result.jobsSchema.version).toBeGreaterThan(0)
    const [version] = await ownerQuery<{ version: number }>('select version from pgboss.version')
    expect(version?.version).toBe(result.jobsSchema.version)
    const tables = await ownerQuery<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'pgboss' and tablename in ('job', 'queue', 'schedule', 'version')",
    )
    expect(tables.map((row) => row.tablename).sort()).toEqual(['job', 'queue', 'schedule', 'version'])
  })

  it('повторный запуск ничего не применяет: ни миграций drizzle, ни схемы очереди', async () => {
    const [before] = await ownerQuery<{ version: number }>('select version from pgboss.version')
    const result = await runMigrations({ url: ownerUrl })

    expect(result.applied).toEqual([])
    expect(result.jobsSchema).toEqual({ version: before?.version, changed: false })
  })

  it('запуск не оставляет в базе экземпляра, очередей и расписаний', async () => {
    // The migrator is not an instance of the queue: it must not be listed as one or leave schedules behind.
    for (const table of ['schedule', 'instance', 'queue']) {
      const [rows] = await ownerQuery<{ count: string }>(`select count(*) as count from pgboss.${table}`)
      expect(Number(rows?.count), table).toBe(0)
    }
  })

  it('недоступная база — исключение: migrate завершится с ненулевым кодом', async () => {
    await expect(
      runMigrations({ url: urlFor(ROLE, PASSWORD, 'ryadom_no_such_database'), lockTimeoutMs: 1_000 }),
    ).rejects.toThrow()
  })
})

describe('шаблон тестовой базы', () => {
  it('имя шаблона зависит от версии pg-boss: новая версия пересоздаёт шаблон', () => {
    const folder = defaultMigrationsFolder()
    const current = migrationsHash(folder)
    expect(migrationsHash(folder)).toBe(current)
    expect(migrationsHash(folder, `${pgBossVersion()}-next`)).not.toBe(current)
  })

  it('база, созданная из шаблона, уже содержит схему pgboss', async () => {
    const database = testDatabase()
    const drop = await prepareTestDatabase(database)
    const sql = postgres(database.url, { max: 1, onnotice: () => {} })
    try {
      const [row] = await sql<
        { exists: boolean }[]
      >`select to_regclass('pgboss.version') is not null as exists`
      expect(row?.exists).toBe(true)
    } finally {
      await sql.end({ timeout: 5 })
      await drop()
    }
  })
})
