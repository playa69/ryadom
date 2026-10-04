import { AgentUnavailableError } from '@ryadom/core/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { AppHeader } from '@ryadom/contracts/api/headers'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { apiError, type TransportErrorStatus } from './lib/api-response'
import type { AppDeps, AppEnv } from './lib/context'
import { createJwt } from './lib/jwt'
import { registerPwaServing } from './lib/pwa'
import { versionGate } from './lib/version-gate'
import { registerAllRoutes } from './routes'

/**
 * HTTP application. The middleware order matters:
 *
 * 1. request log, outermost, so the status and duration of every response are visible;
 * 2. CORS, before the gate: the app calls from `https://localhost` (WebView), and without CORS
 *    headers even a 426 looks to it like a dropped connection;
 * 3. body size limit;
 * 4. version gate, before the routes: an outdated client gets 426 before its body is parsed;
 * 5. `/api/*` routes;
 * 6. PWA serving, after the routes: an `/api/*` request with no matching route still gets JSON
 *    rather than HTML.
 */

const TRANSPORT_STATUSES = new Set<number>([400, 401, 404, 413, 422, 426, 429, 500, 501, 502, 503])

/**
 * `pwaRoot` is only for tests of pure API behaviour: `null` disables PWA serving explicitly,
 * no matter whether a local build left `dist/pwa` on disk. Without it the tests would not be
 * deterministic.
 */
export function createApp(deps: AppDeps, pwaRoot?: string | null): Hono<AppEnv> {
  const { logger, policy } = deps
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    const started = performance.now()
    await next()
    const entry = {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
      platform: c.req.header(AppHeader.Platform),
      appVersion: c.req.header(AppHeader.AppVersion),
      jsVersion: c.req.header(AppHeader.JsVersion),
    }
    if (c.req.path === ApiPath.Health) logger.debug(entry, 'request')
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
      ],
      maxAge: 600,
    }),
  )

  app.use(
    '*',
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => apiError(c, 413, 'Request body is too large'),
    }),
  )

  app.use('*', versionGate(policy))

  registerAllRoutes(app, { ...deps, jwt: createJwt(deps.env.MOBILE_JWT_SECRET) })

  registerPwaServing(app, deps, pwaRoot)

  app.notFound((c) => apiError(c, 404, `No route for ${c.req.method} ${c.req.path}`))

  app.onError((error, c) => {
    // The agent is down, which is not our failure: 503, and the screen shows the hotlines
    //.
    if (error instanceof AgentUnavailableError) {
      logger.warn({ err: error, path: c.req.path }, 'Агент диалогов недоступен')
      return apiError(c, 503, 'Dialog agent is unavailable')
    }
    // Hono throws malformed JSON and similar failures as an HTTPException carrying a status.
    if (error instanceof HTTPException && TRANSPORT_STATUSES.has(error.status)) {
      return apiError(c, error.status as TransportErrorStatus, error.message || 'Request failed')
    }
    logger.error({ err: error, method: c.req.method, path: c.req.path }, 'Необработанная ошибка в роуте')
    return apiError(c, 500, 'Internal server error')
  })

  return app
}
