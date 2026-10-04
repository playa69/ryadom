import { CheckHealthRequest, healthService } from '@ryadom/core/services/health-service'
import type { Hono } from 'hono'
import { ApiPath } from '@ryadom/contracts/api/paths'
import type { AppEnv, RouteDeps } from '../lib/context'
import { isDraining } from '../lib/lifecycle'

/**
 * GET /api/health — liveness check for Docker and deployment, including a database check through
 * the core. There is no envelope: monitoring reads this route rather than the app, which is the one
 * exception in the convention test. The version gate lets it through.
 *
 * A pod that is being stopped answers 503 from the first moment, so the balancer takes it out of
 * rotation before its dialogs are closed.
 */
export function healthRoutes(app: Hono<AppEnv>, { logger }: RouteDeps): void {
  app.get(ApiPath.Health, async (c) => {
    const timestamp = new Date().toISOString()
    if (isDraining()) return c.json({ status: 'draining', timestamp }, 503)
    try {
      const { healthy, database } = await healthService.execute(new CheckHealthRequest())
      if (healthy) return c.json({ status: 'ok', timestamp })
      logger.error({ database }, 'Health-check: база недоступна')
    } catch (error) {
      logger.error({ err: error }, 'Health-check упал')
    }
    return c.json({ status: 'error', timestamp }, 503)
  })
}
