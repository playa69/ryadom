// 1. Handler imports
import './check-health/check-health.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { CheckHealthRequest } from './check-health/check-health.request'
export type { CheckHealthRequestData } from './check-health/check-health.request'

// 3. Type re-exports
export type { CheckHealthRequestResult } from './check-health/check-health.types'

// 4. Union type
import type { CheckHealthRequest } from './check-health/check-health.request'

export type HealthServiceRequests = CheckHealthRequest

// 5. Facade
export class HealthService implements IHealthService {
  async execute<T extends HealthServiceRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: HealthServiceRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IHealthService {
  execute<T extends HealthServiceRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const healthService: IHealthService = new HealthService()
