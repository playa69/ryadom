import { randomUUID } from 'node:crypto'
import type { RateLimiter } from './rate-limit'

/**
 * Sliding window in a Redis sorted set: the score is the time of a request, so the window is the
 * range of scores. One script does the whole step, otherwise two replicas that look at the count at
 * the same moment would both let a request through. A refused request is not recorded, same as in
 * the in-memory limiter: a person who keeps pressing the button recovers one window after the last
 * allowed request, not after the last attempt.
 */
const SLIDING_WINDOW = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
if redis.call('ZCARD', key) >= limit then
  return 0
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, windowMs)
return 1
`

const COMMAND = 'ryadomRateLimitHit'

/** What the limiter needs of a client, so that ioredis and its in-memory double both fit. */
export interface ScriptableRedis {
  defineCommand(name: string, definition: { numberOfKeys: number; lua: string }): void
}

type HitCommand = (
  key: string,
  now: number,
  windowMs: number,
  limit: number,
  member: string,
) => Promise<number>

export interface RedisRateLimiterOptions {
  /** Used while Redis is unreachable: a per-replica limit is better than none, and than a closed login. */
  fallback: RateLimiter
  /** Called on a failed attempt, which happens at most once per `retryAfterMs`. */
  onUnavailable(error: unknown): void
  /** Key prefix, so that environments sharing one Redis do not share counters. */
  prefix?: string
  /** After a failure Redis is left alone for this long, so a hung server does not slow every request. */
  retryAfterMs?: number
  now?: () => number
}

export function createRedisRateLimiter(
  redis: ScriptableRedis,
  options: RedisRateLimiterOptions,
): RateLimiter {
  const { fallback, onUnavailable, prefix = 'ryadom:rl:', retryAfterMs = 5_000, now = Date.now } = options
  redis.defineCommand(COMMAND, { numberOfKeys: 1, lua: SLIDING_WINDOW })
  const run = (redis as unknown as Record<string, HitCommand>)[COMMAND]!
  let retryAt = 0

  return {
    async hit(key, rule) {
      if (now() < retryAt) return fallback.hit(key, rule)
      try {
        const allowed = await run.call(
          redis,
          `${prefix}${key}`,
          now(),
          rule.windowMs,
          rule.limit,
          randomUUID(),
        )
        return allowed === 1
      } catch (error) {
        retryAt = now() + retryAfterMs
        onUnavailable(error)
        return fallback.hit(key, rule)
      }
    },
  }
}
