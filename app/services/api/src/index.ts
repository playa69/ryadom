import { createServer } from 'node:http'
import { serve } from '@hono/node-server'
import { configureLogger, shutdownTelemetry, startTelemetry } from '@ryadom/core/shared'
import { WebSocketServer } from 'ws'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { createApp } from './app'
import { closeAllDialogSessions, handleDialogSocket } from './dialogs/gateway'
import { createAnalytics, hasInvalidProjectToken } from './lib/analytics'
import { purgeInactiveAnonymous } from './lib/anonymous-retention'
import { shutdownCore } from './lib/core'
import { startDiaryScheduler } from './lib/diary-scheduler'
import { EnvValidationError, parseEnv } from './lib/env'
import { createJwt } from './lib/jwt'
import { startDraining } from './lib/lifecycle'
import { createLogger, LOG_REDACT } from './lib/logger'
import { createRateLimiter } from './lib/rate-limit'
import { createRedisClient } from './lib/redis'
import { createRedisRateLimiter } from './lib/redis-rate-limiter'
import { createPolicySource } from './lib/release-policy'
import { createSessions } from './lib/sessions'
import { createShutdown } from './lib/shutdown'

/**
 * Application entry point: `pnpm dev:api` (tsx) locally, `node dist/index.js` in Docker (the bundle
 * produced by build.mjs).
 *
 * A single process serves both REST and WebSocket. The upgrade is intercepted before Hono
 * because Hono on Node cannot handle upgrades itself, and a separate port would require a
 * second Ingress.
 */

function loadEnvOrExit() {
  try {
    return parseEnv(process.env)
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message)
      process.exit(1)
    }
    throw error
  }
}

const env = loadEnvOrExit()
// Logger settings and OTLP log export must be in place before the first log entry.
configureLogger({ redact: LOG_REDACT })
startTelemetry()
const logger = createLogger(env.LOG_LEVEL)
// Product analytics (PostHog). A no-op object without POSTHOG_KEY; its queue is flushed on shutdown.
const analytics = createAnalytics(env, logger)
if (hasInvalidProjectToken(env)) {
  // The value is deliberately not logged: if it is a personal API key, it is a secret.
  logger.error(
    'POSTHOG_KEY не похож на токен проекта PostHog (phc_…), аналитика выключена. ' +
      'Личный ключ (phx_…) задаётся как POSTHOG_PERSONAL_API_KEY и никогда не отдаётся клиентам',
  )
}
if (analytics.enabled && !analytics.canErase) {
  logger.warn(
    'Аналитика включена, но стирание профилей в PostHog при удалении аккаунта не настроено ' +
      '(POSTHOG_PERSONAL_API_KEY и POSTHOG_PROJECT_ID): профили удалённых аккаунтов остаются, пока их не уберут вручную',
  )
}

// Native axis from env, JS axis from the bundle baked into this image; fixed for
// the life of the process, so nothing here needs to be re-read.
const policy = createPolicySource(env)

// Redis makes the limits shared by every replica. Without it, or while it is down, each replica
// counts for itself.
const redis = await createRedisClient(env, logger)
const memoryLimiter = createRateLimiter()
const rateLimiter = redis
  ? createRedisRateLimiter(redis, {
      fallback: memoryLimiter,
      onUnavailable: (error) =>
        logger.warn({ err: error }, 'Redis недоступен: лимиты считаются в памяти этого пода'),
    })
  : memoryLimiter
const app = createApp({ env, logger, policy, rateLimiter, analytics })
const jwt = createJwt(env.MOBILE_JWT_SECRET)

// Refresh tokens that have long expired are of no use even for spotting a replay. Hourly is plenty:
// the table only grows by the sessions of the day, and every replica doing it is harmless.
const sessions = createSessions(jwt)
setInterval(() => {
  sessions
    .purgeExpired()
    .catch((error: unknown) => logger.warn({ err: error }, 'Не удалось очистить реестр refresh-токенов'))
}, 60 * 60_000).unref()

// Anonymous accounts that nobody has opened for the retention period are erased, the agent's copy
// included. The first pass comes shortly after start so that a pod that is restarted often still
// gets to it; the switch is for stopping the job without a rebuild.
if (!env.ANONYMOUS_PURGE_DISABLED) {
  const purge = () =>
    purgeInactiveAnonymous().catch((error: unknown) =>
      logger.warn({ err: error }, 'Не удалось очистить неактивные анонимные аккаунты'),
    )
  setTimeout(() => void purge(), 2 * 60_000).unref()
  setInterval(() => void purge(), 60 * 60_000).unref()
}

// The diary's automatic week summaries (REQ-WELL-01); off with the diary itself.
if (env.DIARY_ENABLED) startDiaryScheduler(logger)

const server = serve({ fetch: app.fetch, port: env.PORT, createServer }, (info) => {
  logger.info({ port: info.port, appEnv: env.APP_ENV }, 'приложение слушает порт')
})

// Dialog WebSocket: a single path, everything beyond it is the gateway's decision.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
server.on('upgrade', (request, socket, head) => {
  const path = (request.url ?? '').split('?')[0]
  if (path !== ApiPath.DialogsWs) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    socket.destroy()
    return
  }
  wss.handleUpgrade(request, socket, head, (ws) =>
    handleDialogSocket(ws, { env, jwt, sessions, analytics }, request),
  )
})

server.on('error', (error: NodeJS.ErrnoException) => {
  // The most common case locally is the port being held by another dev server.
  logger.fatal({ err: error, port: env.PORT }, 'приложение не смогло открыть порт')
  process.exit(1)
})

/**
 * Docker and Kubernetes stop the container with SIGTERM; the order of the stop is in lib/shutdown.ts.
 */
const shutdown = createShutdown({
  startDraining,
  closeSessions: closeAllDialogSessions,
  closeServer: (done) => server.close(done),
  finish: () => {
    // Logging shuts down last so that it still records what happened while the DB pool closed.
    void Promise.allSettled([shutdownCore(), redis?.quit(), analytics.shutdown()])
      .finally(() => shutdownTelemetry())
      .finally(() => process.exit(0))
  },
  forceExit: () => process.exit(0),
  log: (signal, graceful) => logger.info({ signal, graceful }, 'приложение останавливается'),
})
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
