// 1. Handler imports
import './commands/insert-self-check-result/insert-self-check-result.handler'
import './commands/delete-self-check-results/delete-self-check-results.handler'
import './commands/delete-self-check-consent/delete-self-check-consent.handler'
import './queries/get-self-check-consent/get-self-check-consent.handler'
import './queries/list-self-check-results/list-self-check-results.handler'
import './queries/get-self-check-result/get-self-check-result.handler'
import './queries/count-self-check-results/count-self-check-results.handler'
import './queries/latest-self-check-results/latest-self-check-results.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { InsertSelfCheckResultCommand } from './commands/insert-self-check-result/insert-self-check-result.command'
export type { InsertSelfCheckResultCommandData } from './commands/insert-self-check-result/insert-self-check-result.command'
export { DeleteSelfCheckResultsCommand } from './commands/delete-self-check-results/delete-self-check-results.command'
export type { DeleteSelfCheckResultsCommandData } from './commands/delete-self-check-results/delete-self-check-results.command'
export { DeleteSelfCheckConsentCommand } from './commands/delete-self-check-consent/delete-self-check-consent.command'
export type { DeleteSelfCheckConsentCommandData } from './commands/delete-self-check-consent/delete-self-check-consent.command'
export { GetSelfCheckConsentQuery } from './queries/get-self-check-consent/get-self-check-consent.query'
export type { GetSelfCheckConsentQueryData } from './queries/get-self-check-consent/get-self-check-consent.query'
export { ListSelfCheckResultsQuery } from './queries/list-self-check-results/list-self-check-results.query'
export type { ListSelfCheckResultsQueryData } from './queries/list-self-check-results/list-self-check-results.query'
export { GetSelfCheckResultQuery } from './queries/get-self-check-result/get-self-check-result.query'
export type { GetSelfCheckResultQueryData } from './queries/get-self-check-result/get-self-check-result.query'
export { CountSelfCheckResultsQuery } from './queries/count-self-check-results/count-self-check-results.query'
export type { CountSelfCheckResultsQueryData } from './queries/count-self-check-results/count-self-check-results.query'
export { LatestSelfCheckResultsQuery } from './queries/latest-self-check-results/latest-self-check-results.query'
export type { LatestSelfCheckResultsQueryData } from './queries/latest-self-check-results/latest-self-check-results.query'

// 3. Type re-exports
export type { InsertSelfCheckResultCommandResult } from './commands/insert-self-check-result/insert-self-check-result.types'
export type { DeleteSelfCheckResultsCommandResult } from './commands/delete-self-check-results/delete-self-check-results.types'
export type { DeleteSelfCheckConsentCommandResult } from './commands/delete-self-check-consent/delete-self-check-consent.types'
export type { GetSelfCheckConsentQueryResult } from './queries/get-self-check-consent/get-self-check-consent.types'
export type { ListSelfCheckResultsQueryResult } from './queries/list-self-check-results/list-self-check-results.types'
export type { GetSelfCheckResultQueryResult } from './queries/get-self-check-result/get-self-check-result.types'
export type { CountSelfCheckResultsQueryResult } from './queries/count-self-check-results/count-self-check-results.types'
export type { LatestSelfCheckResultsQueryResult } from './queries/latest-self-check-results/latest-self-check-results.types'
export type { SelfCheckResultDTO } from './shared/self-check.dto'

// 4. Union type
import type { InsertSelfCheckResultCommand } from './commands/insert-self-check-result/insert-self-check-result.command'
import type { DeleteSelfCheckResultsCommand } from './commands/delete-self-check-results/delete-self-check-results.command'
import type { DeleteSelfCheckConsentCommand } from './commands/delete-self-check-consent/delete-self-check-consent.command'
import type { GetSelfCheckConsentQuery } from './queries/get-self-check-consent/get-self-check-consent.query'
import type { ListSelfCheckResultsQuery } from './queries/list-self-check-results/list-self-check-results.query'
import type { GetSelfCheckResultQuery } from './queries/get-self-check-result/get-self-check-result.query'
import type { CountSelfCheckResultsQuery } from './queries/count-self-check-results/count-self-check-results.query'
import type { LatestSelfCheckResultsQuery } from './queries/latest-self-check-results/latest-self-check-results.query'

export type SelfCheckManagerRequests =
  | InsertSelfCheckResultCommand
  | DeleteSelfCheckResultsCommand
  | DeleteSelfCheckConsentCommand
  | GetSelfCheckConsentQuery
  | ListSelfCheckResultsQuery
  | LatestSelfCheckResultsQuery
  | GetSelfCheckResultQuery
  | CountSelfCheckResultsQuery

// 5. Facade
export class SelfCheckManager implements ISelfCheckManager {
  async execute<T extends SelfCheckManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: SelfCheckManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface ISelfCheckManager {
  execute<T extends SelfCheckManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const selfCheckManager: ISelfCheckManager = new SelfCheckManager()
