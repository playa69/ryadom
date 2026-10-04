import { sql } from 'drizzle-orm'
import type { Executor } from './client'

export type DbHealth = { ok: true; latencyMs: number } | { ok: false; latencyMs: number; error: string }

/** `select 1` with a timeout, for /health and /api/health. Never throws. */
export async function checkDb(db: Executor, timeoutMs = 3000): Promise<DbHealth> {
  const started = performance.now()
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      db.execute(sql`select 1`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`database did not answer in ${timeoutMs} ms`)), timeoutMs)
      }),
    ])
    return { ok: true, latencyMs: Math.round(performance.now() - started) }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}
