import type { Hono } from 'hono'
import { ApiPath } from '@ryadom/contracts/api/paths'
import { toAnalyticsConfig } from '../lib/analytics'
import { apiOk } from '../lib/api-response'
import type { AppEnv, RouteDeps } from '../lib/context'

/**
 * `GET /api/analytics/config`: what the clients should do about analytics at startup (see the
 * contract). Open, because it is asked before anyone signs in, and free of personal data: the project
 * token is public by design. Cached for five minutes, which is how long a switch flipped in the
 * ConfigMap takes to reach the clients that are already open.
 */
export function analyticsRoutes(app: Hono<AppEnv>, { env }: RouteDeps): void {
  app.get(ApiPath.AnalyticsConfig, (c) => {
    c.header('Cache-Control', 'public, max-age=300')
    return apiOk(c, toAnalyticsConfig(env))
  })
}
