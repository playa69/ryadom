import { CheckHealthRequest, healthService } from '@ryadom/core/services/health-service'
import type { Hono } from 'hono'
import { ApiPath } from '@ryadom/contracts/api/paths'
import type { AppEnv, RouteDeps } from '../lib/context'
import { isDraining } from '../lib/lifecycle'

/**
 * Two probes, both bare JSON for monitoring (no envelope: the one exception in the convention test),
 * both let through by the version gate.
 *
 * GET /api/health — readiness: the process is up and the database answers (through the core). A pod
 * that is being stopped answers 503 from the first moment, so the balancer takes it out of rotation
 * before its dialogs are closed.
 *
 * GET /api/health/live — liveness: the process answers, nothing else. It deliberately skips the
 * database: restarting a pod does not bring a database back, and a restart drops every dialog the pod
 * holds. It keeps answering 200 while draining, so a pod that is shutting down is not killed early.
 */
export function healthRoutes(app: Hono<AppEnv>, { logger }: RouteDeps): void {
  app.get(ApiPath.HealthLive, (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

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
