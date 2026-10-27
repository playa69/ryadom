import type { Hono } from 'hono'
import { metricsRegistry } from '../lib/metrics'
import type { AppEnv, RouteDeps } from '../lib/context'

/**
 * GET /metrics: the Prometheus text format, read by Prometheus inside the cluster. Not under `/api`, so the
 * ingress route (`PathPrefix /api`) never carries it to the internet; like `/api/health` it is no envelope.
 */
export function metricsRoutes(app: Hono<AppEnv>, _deps: RouteDeps): void {
  app.get('/metrics', async (c) => {
    c.header('Content-Type', metricsRegistry.contentType)
    return c.body(await metricsRegistry.metrics())
  })
}
