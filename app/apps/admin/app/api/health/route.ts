import { CheckHealthRequest, healthService } from '@ryadom/core/services/health-service'
import { createLogger } from '@ryadom/core/shared'

/**
 * Readiness probe. The admin is useless without the database, so the check actually queries it
 * instead of only proving the process is up.
 */
export const dynamic = 'force-dynamic'

const logger = createLogger('admin.health')

export async function GET() {
  const timestamp = new Date().toISOString()
  try {
    const { healthy, database } = await healthService.execute(new CheckHealthRequest())
    if (healthy) return Response.json({ status: 'ok', timestamp })
    logger.error('Health check: database unavailable', undefined, { database })
  } catch (error) {
    logger.error('Health check failed', error)
  }
  return Response.json({ status: 'error', timestamp }, { status: 503 })
}
