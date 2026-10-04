// 1. Handler imports
import './toggle-user-activation/toggle-user-activation.handler'
import './confirm-user-email/confirm-user-email.handler'
import './delete-user-account/delete-user-account.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { ToggleUserActivationOperation } from './toggle-user-activation/toggle-user-activation.operation'
export type { ToggleUserActivationOperationData } from './toggle-user-activation/toggle-user-activation.operation'
export { ConfirmUserEmailOperation } from './confirm-user-email/confirm-user-email.operation'
export type { ConfirmUserEmailOperationData } from './confirm-user-email/confirm-user-email.operation'
export { DeleteUserAccountOperation } from './delete-user-account/delete-user-account.operation'
export type { DeleteUserAccountOperationData } from './delete-user-account/delete-user-account.operation'

// 3. Type re-exports
export type { ToggleUserActivationResult } from './toggle-user-activation/toggle-user-activation.types'
export { ToggleUserActivationOperationErrorCode } from './toggle-user-activation/toggle-user-activation.types'
export type { ConfirmUserEmailResult } from './confirm-user-email/confirm-user-email.types'
export { ConfirmUserEmailOperationErrorCode } from './confirm-user-email/confirm-user-email.types'
export type { DeleteUserAccountResult } from './delete-user-account/delete-user-account.types'
export { DeleteUserAccountOperationErrorCode } from './delete-user-account/delete-user-account.types'
export type { UserDTO } from '../../managers/users-manager'

// 4. Union type
import type { ToggleUserActivationOperation } from './toggle-user-activation/toggle-user-activation.operation'
import type { ConfirmUserEmailOperation } from './confirm-user-email/confirm-user-email.operation'
import type { DeleteUserAccountOperation } from './delete-user-account/delete-user-account.operation'

export type UserManagementOperations =
  | ToggleUserActivationOperation
  | ConfirmUserEmailOperation
  | DeleteUserAccountOperation

// 5. Facade
export class UserManagementProcess implements IUserManagementProcess {
  async execute<T extends UserManagementOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: UserManagementOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IUserManagementProcess {
  execute<T extends UserManagementOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const userManagementProcess: IUserManagementProcess = new UserManagementProcess()
