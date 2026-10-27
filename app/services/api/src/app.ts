import { createIngestProxy } from '@ryadom/analytics/ingest-proxy'
import { AgentUnavailableError, resolveClientIp } from '@ryadom/core/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { AppHeader, TracingHeader } from '@ryadom/contracts/api/headers'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, type TransportErrorStatus } from './lib/api-response'
import type { AppDeps, AppEnv } from './lib/context'
import { createJwt } from './lib/jwt'
import { createSessions } from './lib/sessions'
import { limitByIp, RATE_LIMITS } from './lib/rate-limit'
import { tracing } from './lib/tracing'
import { versionGate } from './lib/version-gate'
import { registerAllRoutes } from './routes'

/**
 * HTTP application. The middleware order matters:
 *
 * 1. tracing context, outermost, so that even the request log carries the trace id;
 * 2. request log, so the status and duration of every response are visible;
 * 3. CORS, before the gate: the app calls from `https://localhost` (WebView), and without CORS
 *    headers even a 426 looks to it like a dropped connection;
 * 4. the analytics proxy (`/api/ingest/*`), only when analytics are on. It sits above the body limit
 *    and the version gate on purpose: it has a body limit of its own, and PostHog's SDK sends none
 *    of the app's headers, so it must not be judged by them;
 * 5. body size limit;
 * 6. version gate, before the routes: an outdated client gets 426 before its body is parsed;
 * 7. `/api/*` routes; anything without a matching route gets a JSON 404.
 *
 * The API serves no client: the PWA is its own image (apps/mobile/Dockerfile).
 */

const TRANSPORT_STATUSES = new Set<number>([400, 401, 404, 413, 422, 426, 429, 500, 501, 502, 503])

/** A link's token is its secret: the access log keeps the route, not the token. */
function redactedPath(path: string): string {
  return path.startsWith(`${ApiPath.Shared}/`) ? `${ApiPath.Shared}/:token` : path
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { logger, policy } = deps
  const app = new Hono<AppEnv>()

  app.use('*', tracing())

  // The client address for the per-IP rate limits: the entry the trusted proxy appended to
  // X-Forwarded-For (TRUSTED_PROXY_HOPS), not the one the client wrote.
  app.use('*', async (c, next) => {
    c.set(
      'clientIp',
      resolveClientIp(c.req.header('X-Forwarded-For'), c.req.header('X-Real-IP'), deps.env.TRUSTED_PROXY_HOPS),
    )
    await next()
  })

  app.use('*', async (c, next) => {
    const started = performance.now()
    await next()
    const entry = {
      method: c.req.method,
      path: redactedPath(c.req.path),
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      platform: c.req.header(AppHeader.Platform),
      appVersion: c.req.header(AppHeader.AppVersion),
      jsVersion: c.req.header(AppHeader.JsVersion),
    }
    // Probes and the analytics firehose (a request every few seconds per open tab) stay out of the info log.
    if (c.req.path === ApiPath.Health || c.req.path.startsWith(`${ApiPath.Ingest}/`)) logger.debug(entry, 'request')
    else logger.info(entry, 'request')
  })

  app.use(
    '*',
    cors({
      // Authorization travels in a header and there are no cookies, so any origin is safe; the
      // WebView origin differs per build and under live reload anyway.
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        AppHeader.Authorization,
        AppHeader.Platform,
        AppHeader.AppVersion,
        AppHeader.JsVersion,
        // The web app calls from another origin and sends them on every request.
        ...Object.values(TracingHeader),
      ],
      maxAge: 600,
    }),
  )

  // A reverse proxy to PostHog for the clients' analytics (see packages/analytics). Without a project
  // key there is nothing to proxy to, so the path simply does not exist.
  if (deps.analytics.enabled) {
    const ingest = createIngestProxy({
      ingestHost: deps.env.POSTHOG_HOST,
      assetsHost: deps.env.POSTHOG_ASSETS_HOST,
      basePath: ApiPath.Ingest,
      // Room for a large batch of events.
      maxBodyBytes: 4 * 1024 * 1024,
    })
    app.all(
      `${ApiPath.Ingest}/*`,
      limitByIp(deps.rateLimiter, 'ingest', RATE_LIMITS.ingest.perIp),
      (c) => ingest(c.req.raw),
    )
  }

  app.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => apiError(c, 413, 'Request body is too large'),
    }),
  )

  app.use('*', versionGate(policy))

  const jwt = createJwt(deps.env.MOBILE_JWT_SECRET)
  registerAllRoutes(app, { ...deps, jwt, sessions: createSessions(jwt) })

  app.notFound((c) => apiError(c, 404, `No route for ${c.req.method} ${c.req.path}`))

  app.onError((error, c) => {
    // The agent is down, which is not our failure: 503, and the screen shows the hotlines
    //.
    if (error instanceof AgentUnavailableError) {
      logger.warn({ err: error, path: redactedPath(c.req.path) }, 'Агент диалогов недоступен')
      return apiError(c, 503, 'Dialog agent is unavailable')
    }
    // Hono throws malformed JSON and similar failures as an HTTPException carrying a status.
    if (error instanceof HTTPException && TRANSPORT_STATUSES.has(error.status)) {
      return apiError(c, error.status as TransportErrorStatus, error.message || 'Request failed')
    }
    logger.error({ err: error, method: c.req.method, path: redactedPath(c.req.path) }, 'Необработанная ошибка в роуте')
    return apiError(c, 500, 'Internal server error')
  })

  return app
}
