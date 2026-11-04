// 1. Handler imports
import './send-push/send-rustore-push.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { SendRuStorePushRequest } from './send-push/send-rustore-push.request'
export type { SendRuStorePushRequestData } from './send-push/send-rustore-push.request'

// 3. Type re-exports
export type { SendRuStorePushResponse } from './send-push/send-rustore-push.types'
export { SendRuStorePushRequestErrorCode } from './send-push/send-rustore-push.types'

// 4. Union type
import type { SendRuStorePushRequest } from './send-push/send-rustore-push.request'

export type RuStorePushIntegrationRequests = SendRuStorePushRequest

// 5. Facade
export class RuStorePushIntegration implements IRuStorePushIntegration {
  async execute<T extends RuStorePushIntegrationRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: RuStorePushIntegrationRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IRuStorePushIntegration {
  execute<T extends RuStorePushIntegrationRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const ruStorePushIntegration: IRuStorePushIntegration = new RuStorePushIntegration()
