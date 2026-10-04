// 1. Handler imports
import './commands/record-user-consent/record-user-consent.handler'
import './queries/list-user-consents/list-user-consents.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { RecordUserConsentCommand } from './commands/record-user-consent/record-user-consent.command'
export type { RecordUserConsentCommandData } from './commands/record-user-consent/record-user-consent.command'
export { ListUserConsentsQuery } from './queries/list-user-consents/list-user-consents.query'
export type { ListUserConsentsQueryData } from './queries/list-user-consents/list-user-consents.query'

// 3. Type re-exports
export type { RecordUserConsentCommandResult } from './commands/record-user-consent/record-user-consent.types'
export { RecordUserConsentCommandErrorCode } from './commands/record-user-consent/record-user-consent.types'
export type { ListUserConsentsQueryResult } from './queries/list-user-consents/list-user-consents.types'
export type { UserConsentDTO } from './shared/user-consent.dto'

// 4. Union type
import type { RecordUserConsentCommand } from './commands/record-user-consent/record-user-consent.command'
import type { ListUserConsentsQuery } from './queries/list-user-consents/list-user-consents.query'

export type UserConsentsManagerRequests = RecordUserConsentCommand | ListUserConsentsQuery

// 5. Facade
export class UserConsentsManager implements IUserConsentsManager {
  async execute<T extends UserConsentsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: UserConsentsManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IUserConsentsManager {
  execute<T extends UserConsentsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const userConsentsManager: IUserConsentsManager = new UserConsentsManager()
