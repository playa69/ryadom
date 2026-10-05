import { AsyncLocalStorage } from 'node:async_hooks'
import { createDb, type Db, type DbHandle, type Executor, type Tx } from '@ryadom/db'

/**
 * Core database: a lazy singleton keyed by DATABASE_URL. The handle is kept on globalThis because
 * in Next.js dev mode the module can be evaluated again, and every HMR would otherwise open a new
 * connection pool.
 */
const globalStore = globalThis as typeof globalThis & { __ryadomCoreDb?: DbHandle }
const txStorage = new AsyncLocalStorage<Tx>()

function databaseUrl(): string {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  return url
}

function rootDb(): Db {
  globalStore.__ryadomCoreDb ??= createDb(databaseUrl(), { applicationName: 'ryadom-core' })
  return globalStore.__ryadomCoreDb.db
}

/**
 * Query executor for managers and technical services: the transaction opened by `inTransaction`
 * for the current async context, or the shared pool.
 */
export function getDb(): Executor {
  return txStorage.getStore() ?? rootDb()
}

/**
 * Transaction boundary for a process: every manager call inside `fn` runs in one transaction
 * (AsyncLocalStorage), and a nested call joins the outer transaction. Emails and outbound HTTP
 * calls happen after it, not inside.
 */
export async function inTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (txStorage.getStore()) return fn()
  return rootDb().transaction((tx) => txStorage.run(tx, fn))
}

/**
 * Savepoint: an error inside it, a unique violation for example, rolls back only the savepoint and
 * leaves the outer transaction usable. Outside a transaction it opens one of its own.
 */
export async function withSavepoint<T>(fn: (db: Executor) => Promise<T>): Promise<T> {
  const current = txStorage.getStore()
  const runner = current ?? rootDb()
  return runner.transaction((savepoint) => txStorage.run(savepoint, () => fn(savepoint)))
}

/** Postgres unique_violation (23505); drizzle may wrap the driver error in `cause`. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause]
  return candidates.some((candidate) => {
    const pgError = candidate as { code?: string; constraint_name?: string } | null | undefined
    if (pgError?.code !== '23505') return false
    return constraint === undefined || pgError.constraint_name === constraint
  })
}

/** Postgres foreign_key_violation (23503). */
export function isForeignKeyViolation(error: unknown): boolean {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause]
  return candidates.some((candidate) => (candidate as { code?: string } | null | undefined)?.code === '23503')
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Identifiers also arrive from URLs: a non-UUID cannot exist, and a query with it would fail. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

/** Closes the pool (CLI, tests, graceful shutdown). */
export async function closeDb(): Promise<void> {
  const handle = globalStore.__ryadomCoreDb
  if (!handle) return
  globalStore.__ryadomCoreDb = undefined
  await handle.close()
}
