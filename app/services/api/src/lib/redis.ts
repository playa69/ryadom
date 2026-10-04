import { lookup } from 'node:dns/promises'
import { Redis } from 'ioredis'
import type { AppServerEnv } from './env'
import type { Logger } from './logger'

/**
 * Sentinel nodes sit behind a headless Service, where every pod is an A record. ioredis connects
 * to the addresses it is given and a name would always lead to the same pod, so the names are
 * resolved up front. If the name does not resolve (a single local node, say) it is used as it is.
 */
export async function resolveSentinels(
  host: string,
  port: number,
  resolve: typeof lookup = lookup,
): Promise<{ host: string; port: number }[]> {
  try {
    const addresses = await resolve(host, { all: true, family: 4 })
    const hosts = [...new Set(addresses.map((address) => address.address))]
    if (hosts.length > 0) return hosts.map((address) => ({ host: address, port }))
  } catch {
    // Not resolvable: fall through to the name itself.
  }
  return [{ host, port }]
}

/** An unreachable Redis makes ioredis emit an error on every reconnect; one line per interval is enough. */
const ERROR_LOG_INTERVAL_MS = 30_000

/**
 * The Redis client, or null when `REDIS_ENABLED` is off. It is built to fail fast: with no offline
 * queue a command sent while the connection is down is refused at once, so the rate limiter can
 * count in memory instead of making requests wait for a server that is not there.
 */
export async function createRedisClient(env: AppServerEnv, logger: Logger): Promise<Redis | null> {
  if (!env.REDIS_ENABLED) return null

  const options = {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
    commandTimeout: 250,
    password: env.REDIS_PASSWORD,
  }
  const client = env.REDIS_URL
    ? new Redis(env.REDIS_URL, options)
    : new Redis({
        ...options,
        name: env.REDIS_MASTER_NAME,
        sentinels: await resolveSentinels(env.REDIS_SENTINEL_HOST!, env.REDIS_SENTINEL_PORT),
        // Bitnami sets requirepass on the Sentinel port too: without it the master is never found.
        sentinelPassword: env.REDIS_PASSWORD,
      })

  let lastErrorLog = 0
  client.on('error', (error) => {
    if (Date.now() - lastErrorLog < ERROR_LOG_INTERVAL_MS) return
    lastErrorLog = Date.now()
    logger.warn({ err: error }, 'Redis: ошибка соединения')
  })
  client.on('ready', () => logger.info('Redis подключён'))
  return client
}
