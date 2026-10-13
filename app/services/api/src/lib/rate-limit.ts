import type { Context, MiddlewareHandler } from 'hono'
import { UNKNOWN_CLIENT_IP } from '@ryadom/core/shared'
import { apiError } from './api-response'
import type { AppEnv } from './context'

/**
 * Rate limiting. It protects what is open without authorization: email codes, login and password
 * recovery.
 *
 * Two implementations behind one interface. This file holds the one in process memory, which counts
 * per replica: with three replicas the effective total limit is three times the stated one. That is
 * enough against brute force on its own, and it is what runs without Redis. `redis-rate-limiter.ts`
 * counts in Redis, shared by every replica, and falls back to this one when Redis is unreachable.
 */
export interface RateLimitRule {
  /** How many requests are allowed within the window. */
  limit: number
  windowMs: number
}

export interface RateLimiter {
  /** false means the limit is exhausted; a refused request is not counted. */
  hit(key: string, rule: RateLimitRule): Promise<boolean>
}

/** The in-memory limiter can be emptied, which tests need between assertions. */
export interface ResettableRateLimiter extends RateLimiter {
  reset(): void
}

export function createRateLimiter(now: () => number = Date.now): ResettableRateLimiter {
  const hits = new Map<string, number[]>()

  return {
    async hit(key, rule) {
      const current = now()
      const from = current - rule.windowMs
      const recent = (hits.get(key) ?? []).filter((time) => time > from)
      // Pruned on every call, otherwise keys accumulate for as long as the process lives.
      if (recent.length >= rule.limit) {
        hits.set(key, recent)
        return false
      }
      recent.push(current)
      hits.set(key, recent)
      return true
    },
    reset() {
      hits.clear()
    },
  }
}

/** The rules, kept in one place instead of being spread across the routes. */
export const RATE_LIMITS = {
  /** Email with a code: registration, resend, "forgot password". */
  emailCode: { perEmail: { limit: 3, windowMs: 10 * 60_000 }, perIp: { limit: 20, windowMs: 60 * 60_000 } },
  /** Entering a code or a password: guessing a six-digit code must hit the limit, not luck. */
  attempt: { perIp: { limit: 10, windowMs: 60_000 } },
  /**
   * Device sign-in, which also makes an account for a new device. Per hour, not per minute: the
   * app calls it once at install and again only when a session is lost, but many people share one
   * address behind carrier NAT.
   */
  deviceLogin: { perIp: { limit: 30, windowMs: 60 * 60_000 } },
  /**
   * The analytics proxy. The SDK batches, so a busy tab sends a request every few seconds and a
   * session recording a few more; this leaves room for a household or a carrier-NAT address and
   * still stops a script from using the proxy as a free relay to PostHog.
   */
  ingest: { perIp: { limit: 1200, windowMs: 60_000 } },
  /** Starting a dialog: protection against an accidental loop in the client. */
  dialogStart: { perUser: { limit: 30, windowMs: 60_000 } },
  /**
   * The agent's memory. Reading covers the screen and the "I remembered" card, which asks every three
   * seconds for half a minute after a conversation; changes are taps on cards. Both are far above what
   * a person does and stop a client stuck in a loop from hammering the agent.
   */
  memoryRead: { perUser: { limit: 120, windowMs: 60_000 } },
  memoryWrite: { perUser: { limit: 60, windowMs: 60_000 } },
  /** "Download my memory": the whole of it at once, so a few times per ten minutes. */
  memoryExport: { perUser: { limit: 5, windowMs: 10 * 60_000 } },
} as const

/**
 * The request IP. It is resolved once per request in `createApp` from X-Forwarded-For and
 * `TRUSTED_PROXY_HOPS` (core's `resolveClientIp`): the entry our own proxy appended, not the
 * first one, which the client writes itself and could change on every request to dodge the limit.
 */
export function clientIp(c: Context<AppEnv>): string {
  return c.get('clientIp') ?? UNKNOWN_CLIENT_IP
}

/**
 * Per-IP limit for a route. The key includes the route name, so guessing a code must not consume
 * the login limit, and vice versa.
 */
export function limitByIp(limiter: RateLimiter, name: string, rule: RateLimitRule): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!(await limiter.hit(`ip:${name}:${clientIp(c)}`, rule))) {
      return apiError(c, 429, 'Too many requests: try again later')
    }
    return next()
  }
}
