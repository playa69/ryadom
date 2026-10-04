import { createServer } from 'node:http'
import { serve } from '@hono/node-server'
import { configureLogger, shutdownTelemetry, startTelemetry } from '@ryadom/core/shared'
import { WebSocketServer } from 'ws'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { createApp } from './app'
import { closeAllDialogSessions, handleDialogSocket } from './dialogs/gateway'
import { shutdownCore } from './lib/core'
import { EnvValidationError, parseEnv } from './lib/env'
import { createJwt } from './lib/jwt'
import { startDraining } from './lib/lifecycle'
import { createLogger, LOG_REDACT } from './lib/logger'
import { createRateLimiter } from './lib/rate-limit'
import { createPolicySource } from './lib/release-policy'
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

// Native axis from env, JS axis from the bundle baked into this image; fixed for
// the life of the process, so nothing here needs to be re-read.
const policy = createPolicySource(env)

const rateLimiter = createRateLimiter()
const app = createApp({ env, logger, policy, rateLimiter })
const jwt = createJwt(env.MOBILE_JWT_SECRET)

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
  wss.handleUpgrade(request, socket, head, (ws) => handleDialogSocket(ws, { env, jwt }))
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
    void shutdownCore()
      .finally(() => shutdownTelemetry())
      .finally(() => process.exit(0))
  },
  forceExit: () => process.exit(0),
  log: (signal, graceful) => logger.info({ signal, graceful }, 'приложение останавливается'),
})
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
