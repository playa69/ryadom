// 1. Handler imports
import './delete-account/delete-account.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { DeleteAccountOperation } from './delete-account/delete-account.operation'
export type { DeleteAccountOperationData } from './delete-account/delete-account.operation'

// 3. Type re-exports
export type { DeleteAccountResult } from './delete-account/delete-account.types'
export { DeleteAccountOperationErrorCode } from './delete-account/delete-account.types'

// 4. Union type
import type { DeleteAccountOperation } from './delete-account/delete-account.operation'

export type AccountDeletionOperations =
  | DeleteAccountOperation

// 5. Facade
export class AccountDeletionProcess implements IAccountDeletionProcess {
  async execute<T extends AccountDeletionOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: AccountDeletionOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IAccountDeletionProcess {
  execute<T extends AccountDeletionOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const accountDeletionProcess: IAccountDeletionProcess = new AccountDeletionProcess()
