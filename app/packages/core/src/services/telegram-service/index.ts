// 1. Handler imports
import './verify-init-data/verify-init-data.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { VerifyInitDataRequest } from './verify-init-data/verify-init-data.request'
export type { VerifyInitDataRequestData } from './verify-init-data/verify-init-data.request'

// 3. Type re-exports
export type { VerifyInitDataRequestResult } from './verify-init-data/verify-init-data.types'
export { VerifyInitDataRequestErrorCode } from './verify-init-data/verify-init-data.types'
export { checkInitData, signInitData, type InitDataCheck, type TelegramInitDataUser } from './init-data'

// 4. Union type
import type { VerifyInitDataRequest } from './verify-init-data/verify-init-data.request'

export type TelegramServiceRequests = VerifyInitDataRequest

// 5. Facade
export class TelegramService implements ITelegramService {
  async execute<T extends TelegramServiceRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: TelegramServiceRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface ITelegramService {
  execute<T extends TelegramServiceRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const telegramService: ITelegramService = new TelegramService()
