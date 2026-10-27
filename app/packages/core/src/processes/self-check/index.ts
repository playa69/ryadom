// 1. Handler imports
import './save-self-check-result/save-self-check-result.handler'
import './list-self-check-results/list-self-check-results.handler'
import './latest-self-check-results/latest-self-check-results.handler'
import './delete-self-check-results/delete-self-check-results.handler'
import './get-self-check-consent/get-self-check-consent.handler'
import './give-self-check-consent/give-self-check-consent.handler'
import './revoke-self-check-consent/revoke-self-check-consent.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { SaveSelfCheckResultOperation } from './save-self-check-result/save-self-check-result.operation'
export type { SaveSelfCheckResultOperationData } from './save-self-check-result/save-self-check-result.operation'
export { ListSelfCheckResultsOperation } from './list-self-check-results/list-self-check-results.operation'
export type { ListSelfCheckResultsOperationData } from './list-self-check-results/list-self-check-results.operation'
export { LatestSelfCheckResultsOperation } from './latest-self-check-results/latest-self-check-results.operation'
export type { LatestSelfCheckResultsOperationData } from './latest-self-check-results/latest-self-check-results.operation'
export { DeleteSelfCheckResultsOperation } from './delete-self-check-results/delete-self-check-results.operation'
export type { DeleteSelfCheckResultsOperationData } from './delete-self-check-results/delete-self-check-results.operation'
export { GetSelfCheckConsentOperation } from './get-self-check-consent/get-self-check-consent.operation'
export type { GetSelfCheckConsentOperationData } from './get-self-check-consent/get-self-check-consent.operation'
export { GiveSelfCheckConsentOperation } from './give-self-check-consent/give-self-check-consent.operation'
export type { GiveSelfCheckConsentOperationData } from './give-self-check-consent/give-self-check-consent.operation'
export { RevokeSelfCheckConsentOperation } from './revoke-self-check-consent/revoke-self-check-consent.operation'
export type { RevokeSelfCheckConsentOperationData } from './revoke-self-check-consent/revoke-self-check-consent.operation'

// 3. Type re-exports
export { SaveSelfCheckResultOperationErrorCode } from './save-self-check-result/save-self-check-result.types'
export type { SaveSelfCheckResultResult } from './save-self-check-result/save-self-check-result.types'
export { ListSelfCheckResultsOperationErrorCode } from './list-self-check-results/list-self-check-results.types'
export type { ListSelfCheckResultsResult } from './list-self-check-results/list-self-check-results.types'
export { LatestSelfCheckResultsOperationErrorCode } from './latest-self-check-results/latest-self-check-results.types'
export type { LatestSelfCheckResultsResult } from './latest-self-check-results/latest-self-check-results.types'
export { DeleteSelfCheckResultsOperationErrorCode } from './delete-self-check-results/delete-self-check-results.types'
export type { DeleteSelfCheckResultsResult } from './delete-self-check-results/delete-self-check-results.types'
export { GetSelfCheckConsentOperationErrorCode } from './get-self-check-consent/get-self-check-consent.types'
export type { GetSelfCheckConsentResult } from './get-self-check-consent/get-self-check-consent.types'
export { GiveSelfCheckConsentOperationErrorCode } from './give-self-check-consent/give-self-check-consent.types'
export type { GiveSelfCheckConsentResult } from './give-self-check-consent/give-self-check-consent.types'
export { RevokeSelfCheckConsentOperationErrorCode } from './revoke-self-check-consent/revoke-self-check-consent.types'
export type { RevokeSelfCheckConsentResult } from './revoke-self-check-consent/revoke-self-check-consent.types'

// 4. Union type
import type { SaveSelfCheckResultOperation } from './save-self-check-result/save-self-check-result.operation'
import type { ListSelfCheckResultsOperation } from './list-self-check-results/list-self-check-results.operation'
import type { LatestSelfCheckResultsOperation } from './latest-self-check-results/latest-self-check-results.operation'
import type { DeleteSelfCheckResultsOperation } from './delete-self-check-results/delete-self-check-results.operation'
import type { GetSelfCheckConsentOperation } from './get-self-check-consent/get-self-check-consent.operation'
import type { GiveSelfCheckConsentOperation } from './give-self-check-consent/give-self-check-consent.operation'
import type { RevokeSelfCheckConsentOperation } from './revoke-self-check-consent/revoke-self-check-consent.operation'

export type SelfCheckOperations =
  | SaveSelfCheckResultOperation
  | ListSelfCheckResultsOperation
  | LatestSelfCheckResultsOperation
  | DeleteSelfCheckResultsOperation
  | GetSelfCheckConsentOperation
  | GiveSelfCheckConsentOperation
  | RevokeSelfCheckConsentOperation

// 5. Facade
export class SelfCheckProcess implements ISelfCheckProcess {
  async execute<T extends SelfCheckOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: SelfCheckOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface ISelfCheckProcess {
  execute<T extends SelfCheckOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const selfCheckProcess: ISelfCheckProcess = new SelfCheckProcess()
