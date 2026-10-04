import type { DbHealth } from '@ryadom/db'

export interface CheckHealthRequestResult {
  healthy: boolean
  database: DbHealth
}
