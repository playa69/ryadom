import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { checkDb } from '@ryadom/db'
import { getDb } from '../../../shared'
import { CheckHealthRequest } from './check-health.request'
import type { CheckHealthRequestResult } from './check-health.types'

/** For every /api/health route: is the process alive and does the database answer. Never throws. */
@requestHandler(CheckHealthRequest)
export class CheckHealthRequestHandler implements RequestHandler<
  CheckHealthRequest,
  CheckHealthRequestResult
> {
  async handle(): Promise<CheckHealthRequestResult> {
    const database = await checkDb(getDb())
    return { healthy: database.ok, database }
  }
}
