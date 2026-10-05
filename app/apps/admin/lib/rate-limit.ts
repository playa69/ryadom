import 'server-only'

import { headers } from 'next/headers'
import { resolveClientIp } from '@ryadom/core/shared'
import { adminEnv } from './env'

/**
 * Rate limits for the login screen, the only thing reachable without a cookie. In-memory and
 * per-instance: the admin runs as a single replica, and the point is to stop code guessing, not
 * to survive a distributed attack.
 */
const buckets = new Map<string, number[]>()

export const ADMIN_LIMITS = {
  /** Code requests per email address. */
  codeByEmail: { limit: 5, windowMs: 10 * 60 * 1000 },
  /** Code requests per IP, so one address cannot be used to probe many emails. */
  codeByIp: { limit: 20, windowMs: 60 * 60 * 1000 },
  /** Code submissions per IP. The code itself also burns after five wrong attempts. */
  confirmByIp: { limit: 30, windowMs: 10 * 60 * 1000 },
} as const

export function hitLimit(key: string, rule: { limit: number; windowMs: number }): boolean {
  const now = Date.now()
  const hits = (buckets.get(key) ?? []).filter((at) => now - at < rule.windowMs)
  hits.push(now)
  buckets.set(key, hits)
  if (buckets.size > 5000) {
    for (const [bucketKey, times] of buckets) {
      if (times.every((at) => now - at >= rule.windowMs)) buckets.delete(bucketKey)
    }
  }
  return hits.length <= rule.limit
}

/**
 * The address our own reverse proxy reports (the entry it appended to X-Forwarded-For, see
 * `TRUSTED_PROXY_HOPS`), not the first one, which the client writes itself. Without a proxy header
 * everything shares one bucket.
 */
export async function clientIp(): Promise<string> {
  const store = await headers()
  return resolveClientIp(store.get('x-forwarded-for'), store.get('x-real-ip'), adminEnv().TRUSTED_PROXY_HOPS)
}
