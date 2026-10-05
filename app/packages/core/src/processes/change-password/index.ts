// 1. Handler imports
import './change-password/change-password.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { ChangePasswordOperation } from './change-password/change-password.operation'
export type { ChangePasswordOperationData } from './change-password/change-password.operation'

// 3. Type re-exports
export type { ChangePasswordResult } from './change-password/change-password.types'
export { ChangePasswordOperationErrorCode } from './change-password/change-password.types'

// 4. Union type
import type { ChangePasswordOperation } from './change-password/change-password.operation'

export type ChangePasswordOperations =
  | ChangePasswordOperation

// 5. Facade
export class ChangePasswordProcess implements IChangePasswordProcess {
  async execute<T extends ChangePasswordOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: ChangePasswordOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IChangePasswordProcess {
  execute<T extends ChangePasswordOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const changePasswordProcess: IChangePasswordProcess = new ChangePasswordProcess()
