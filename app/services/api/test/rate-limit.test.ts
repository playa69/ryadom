/**
 * Rate limits: the same behaviour from the in-memory limiter and from the Redis one, the Redis
 * counters shared between replicas, and a working fallback when Redis is down.
 */
import RedisMock from 'ioredis-mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRateLimiter, type RateLimiter, type RateLimitRule } from '../src/lib/rate-limit'
import { createRedisClient, resolveSentinels } from '../src/lib/redis'
import { createRedisRateLimiter, type ScriptableRedis } from '../src/lib/redis-rate-limiter'
import { parseEnv } from '../src/lib/env'
import { createLogger } from '../src/lib/logger'

const RULE: RateLimitRule = { limit: 3, windowMs: 60_000 }

function clock(start = 1_000_000) {
  let current = start
  return { now: () => current, advance: (ms: number) => (current += ms) }
}

async function hits(limiter: RateLimiter, key: string, count: number, rule = RULE): Promise<boolean[]> {
  const results: boolean[] = []
  for (let i = 0; i < count; i++) results.push(await limiter.hit(key, rule))
  return results
}

/** The behaviour both implementations promise; each gets the same cases. */
function behaves(name: string, make: (now: () => number) => RateLimiter) {
  describe(name, () => {
    it('пускает limit запросов в окне и отказывает дальше', async () => {
      const { now } = clock()
      expect(await hits(make(now), 'k', 5)).toEqual([true, true, true, false, false])
    })

    it('ключи считаются независимо', async () => {
      const { now } = clock()
      const limiter = make(now)
      await hits(limiter, 'a', 3)
      expect(await limiter.hit('a', RULE)).toBe(false)
      expect(await limiter.hit('b', RULE)).toBe(true)
    })

    it('окно скользит: запрос освобождается через windowMs после себя', async () => {
      const { now, advance } = clock()
      const limiter = make(now)
      expect(await limiter.hit('k', RULE)).toBe(true)
      advance(20_000)
      expect(await hits(limiter, 'k', 2)).toEqual([true, true])
      expect(await limiter.hit('k', RULE)).toBe(false)

      // The first request is 60 s old now, so exactly one place frees up.
      advance(40_000)
      expect(await limiter.hit('k', RULE)).toBe(true)
      expect(await limiter.hit('k', RULE)).toBe(false)
    })

    it('отказ не записывается: настойчивый клиент не удлиняет себе блокировку', async () => {
      const { now, advance } = clock()
      const limiter = make(now)
      await hits(limiter, 'k', 3)
      for (let i = 0; i < 10; i++) {
        advance(5_000)
        expect(await limiter.hit('k', RULE)).toBe(false)
      }
      // 50 s of refused attempts, then the window of the allowed ones (60 s from the first) ends.
      advance(10_001)
      expect(await limiter.hit('k', RULE)).toBe(true)
    })
  })
}

behaves('в памяти', (now) => createRateLimiter(now))

describe('Redis', () => {
  let redis: InstanceType<typeof RedisMock>

  beforeEach(async () => {
    redis = new RedisMock()
    await redis.flushall()
  })

  const make = (now: () => number, options: Partial<Parameters<typeof createRedisRateLimiter>[1]> = {}) =>
    createRedisRateLimiter(redis as unknown as ScriptableRedis, {
      fallback: createRateLimiter(now),
      onUnavailable: () => {},
      now,
      ...options,
    })

  behaves('счётчик в Redis', (now) => make(now))

  it('несколько реплик делят один счётчик', async () => {
    const { now } = clock()
    const replicaA = make(now)
    const replicaB = make(now)

    expect(await hits(replicaA, 'login:1.2.3.4', 2)).toEqual([true, true])
    // The third request goes to another replica and still sees the two before it.
    expect(await replicaB.hit('login:1.2.3.4', RULE)).toBe(true)
    expect(await replicaA.hit('login:1.2.3.4', RULE)).toBe(false)
    expect(await replicaB.hit('login:1.2.3.4', RULE)).toBe(false)
  })

  it('ключи с префиксом и временем жизни: пустое окно не копится в Redis', async () => {
    const { now } = clock()
    await make(now, { prefix: 'test:' }).hit('k', RULE)

    expect(await redis.keys('*')).toEqual(['test:k'])
    const ttl = await redis.pttl('test:k')
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(RULE.windowMs)
  })

  describe('когда Redis недоступен', () => {
    function broken() {
      const defineCommand = vi.fn()
      const calls = vi.fn()
      const client = {
        defineCommand,
        ryadomRateLimitHit: (...args: unknown[]) => {
          calls(...args)
          return Promise.reject(new Error('connection is closed'))
        },
      }
      return { client: client as unknown as ScriptableRedis, calls }
    }

    it('лимит считается в памяти, запросы не падают', async () => {
      const { now } = clock()
      const { client } = broken()
      const limiter = createRedisRateLimiter(client, {
        fallback: createRateLimiter(now),
        onUnavailable: () => {},
        now,
      })
      expect(await hits(limiter, 'k', 4)).toEqual([true, true, true, false])
    })

    it('после сбоя Redis не дёргается retryAfterMs, потом пробуется снова', async () => {
      const { now, advance } = clock()
      const { client, calls } = broken()
      const onUnavailable = vi.fn()
      const limiter = createRedisRateLimiter(client, {
        fallback: createRateLimiter(now),
        onUnavailable,
        retryAfterMs: 5_000,
        now,
      })

      await hits(limiter, 'k', 3)
      expect(calls).toHaveBeenCalledTimes(1)
      expect(onUnavailable).toHaveBeenCalledTimes(1)

      advance(5_001)
      await limiter.hit('k2', RULE)
      expect(calls).toHaveBeenCalledTimes(2)
      expect(onUnavailable).toHaveBeenCalledTimes(2)
    })

    it('Redis вернулся: счёт снова в нём', async () => {
      const { now, advance } = clock()
      let up = false
      const real = new RedisMock()
      await real.flushall()
      const client = {
        defineCommand: (name: string, definition: { numberOfKeys: number; lua: string }) =>
          real.defineCommand(name, definition),
        ryadomRateLimitHit: (...args: unknown[]) =>
          up
            ? (real as unknown as Record<string, (...a: unknown[]) => Promise<number>>).ryadomRateLimitHit!(
                ...args,
              )
            : Promise.reject(new Error('down')),
      }
      const limiter = createRedisRateLimiter(client as unknown as ScriptableRedis, {
        fallback: createRateLimiter(now),
        onUnavailable: () => {},
        retryAfterMs: 1_000,
        now,
      })

      await limiter.hit('k', RULE)
      expect(await real.keys('*')).toEqual([])
      up = true
      advance(1_001)
      await limiter.hit('k', RULE)
      expect(await real.keys('*')).toEqual(['ryadom:rl:k'])
    })
  })
})

describe('адреса Sentinel', () => {
  const resolver = (result: { address: string }[] | Error) =>
    (async () => {
      if (result instanceof Error) throw result
      return result
    }) as unknown as typeof import('node:dns/promises').lookup

  it('имя headless-сервиса раскрывается в адреса подов без повторов', async () => {
    const sentinels = await resolveSentinels(
      'redis',
      26379,
      resolver([{ address: '10.0.0.1' }, { address: '10.0.0.2' }, { address: '10.0.0.1' }]),
    )
    expect(sentinels).toEqual([
      { host: '10.0.0.1', port: 26379 },
      { host: '10.0.0.2', port: 26379 },
    ])
  })

  it('имя, которое не раскрылось, используется как есть', async () => {
    expect(await resolveSentinels('redis', 26379, resolver(new Error('ENOTFOUND')))).toEqual([
      { host: 'redis', port: 26379 },
    ])
    expect(await resolveSentinels('redis', 26379, resolver([]))).toEqual([{ host: 'redis', port: 26379 }])
  })
})

describe('настройка из env', () => {
  const base = {
    ...process.env,
    REDIS_ENABLED: undefined,
    REDIS_URL: undefined,
    REDIS_SENTINEL_HOST: undefined,
    REDIS_MASTER_NAME: undefined,
  }

  it('TRUSTED_PROXY_HOPS по умолчанию 1 (один прокси перед сервисом)', () => {
    expect(parseEnv(base).TRUSTED_PROXY_HOPS).toBe(1)
    expect(parseEnv({ ...base, TRUSTED_PROXY_HOPS: '2' }).TRUSTED_PROXY_HOPS).toBe(2)
    expect(parseEnv({ ...base, TRUSTED_PROXY_HOPS: '0' }).TRUSTED_PROXY_HOPS).toBe(0)
    expect(parseEnv({ ...base, TRUSTED_PROXY_HOPS: '' }).TRUSTED_PROXY_HOPS).toBe(1)
  })

  it('по умолчанию Redis выключен, клиент не создаётся', async () => {
    const env = parseEnv(base)
    expect(env.REDIS_ENABLED).toBeUndefined()
    expect(await createRedisClient(env, createLogger('silent'))).toBeNull()
  })

  it('включённому Redis нужен адрес: либо URL, либо Sentinel с именем мастера', () => {
    expect(() => parseEnv({ ...base, REDIS_ENABLED: 'true' })).toThrow(
      /REDIS_SENTINEL_HOST[\s\S]*REDIS_MASTER_NAME/,
    )
    expect(() => parseEnv({ ...base, REDIS_ENABLED: 'true', REDIS_SENTINEL_HOST: 'redis' })).toThrow(
      /REDIS_MASTER_NAME/,
    )
    expect(parseEnv({ ...base, REDIS_ENABLED: 'true', REDIS_URL: 'redis://localhost:56379' }).REDIS_URL).toBe(
      'redis://localhost:56379',
    )
    const sentinel = parseEnv({
      ...base,
      REDIS_ENABLED: 'true',
      REDIS_SENTINEL_HOST: 'redis',
      REDIS_MASTER_NAME: 'mymaster',
    })
    expect(sentinel.REDIS_SENTINEL_PORT).toBe(26379)
  })

  it('адрес не redis:// отвергается', () => {
    expect(() => parseEnv({ ...base, REDIS_URL: 'http://localhost:6379' })).toThrow(/REDIS_URL/)
  })

  it('выключенному Redis адрес не нужен', () => {
    expect(() => parseEnv({ ...base, REDIS_ENABLED: 'false' })).not.toThrow()
  })
})
