import postgres from 'postgres'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema'

export type Schema = typeof schema
export type Db = PostgresJsDatabase<Schema>
/** A drizzle transaction: the same query API as Db. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
/** Anything a query can run on: the database itself or an open transaction. */
export type Executor = Db | Tx

export interface CreateDbOptions {
  /** Connection pool size, 10 by default. */
  max?: number
  /** Close an idle connection after N seconds, 20 by default. */
  idleTimeout?: number
  /** Connect timeout in seconds, 10 by default. */
  connectTimeout?: number
  /** application_name as shown in pg_stat_activity. */
  applicationName?: string
}

export interface DbHandle {
  db: Db
  sql: postgres.Sql
  close: () => Promise<void>
}

export function createDb(url: string, opts: CreateDbOptions = {}): DbHandle {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: opts.idleTimeout ?? 20,
    connect_timeout: opts.connectTimeout ?? 10,
    // Postgres NOTICEs, "extension already exists" for example, do not belong in application logs.
    onnotice: () => {},
    connection: { application_name: opts.applicationName ?? 'ryadom' },
  })
  const db = drizzle({ client: sql, schema })
  return { db, sql, close: () => sql.end({ timeout: 5 }) }
}
