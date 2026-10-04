// 1. Handler imports
import './accept-consents/accept-consents.handler'
import './get-consent-status/get-consent-status.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { AcceptConsentsOperation } from './accept-consents/accept-consents.operation'
export type { AcceptConsentsOperationData } from './accept-consents/accept-consents.operation'
export { GetConsentStatusOperation } from './get-consent-status/get-consent-status.operation'
export type { GetConsentStatusOperationData } from './get-consent-status/get-consent-status.operation'

// 3. Type re-exports
export type { AcceptConsentsResult } from './accept-consents/accept-consents.types'
export { AcceptConsentsOperationErrorCode } from './accept-consents/accept-consents.types'
export type { ConsentStatusDTO, GetConsentStatusResult } from './get-consent-status/get-consent-status.types'

// 4. Union type
import type { AcceptConsentsOperation } from './accept-consents/accept-consents.operation'
import type { GetConsentStatusOperation } from './get-consent-status/get-consent-status.operation'

export type ConsentsOperations = AcceptConsentsOperation | GetConsentStatusOperation

// 5. Facade
export class ConsentsProcess implements IConsentsProcess {
  async execute<T extends ConsentsOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: ConsentsOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IConsentsProcess {
  execute<T extends ConsentsOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const consentsProcess: IConsentsProcess = new ConsentsProcess()
