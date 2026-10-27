// 1. Handler imports
import './toggle-user-activation/toggle-user-activation.handler'
import './confirm-user-email/confirm-user-email.handler'
import './revoke-user-sessions/revoke-user-sessions.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { ToggleUserActivationOperation } from './toggle-user-activation/toggle-user-activation.operation'
export type { ToggleUserActivationOperationData } from './toggle-user-activation/toggle-user-activation.operation'
export { ConfirmUserEmailOperation } from './confirm-user-email/confirm-user-email.operation'
export type { ConfirmUserEmailOperationData } from './confirm-user-email/confirm-user-email.operation'
export { RevokeUserSessionsOperation } from './revoke-user-sessions/revoke-user-sessions.operation'
export type { RevokeUserSessionsOperationData } from './revoke-user-sessions/revoke-user-sessions.operation'

// 3. Type re-exports
export type { ToggleUserActivationResult } from './toggle-user-activation/toggle-user-activation.types'
export { ToggleUserActivationOperationErrorCode } from './toggle-user-activation/toggle-user-activation.types'
export type { ConfirmUserEmailResult } from './confirm-user-email/confirm-user-email.types'
export { ConfirmUserEmailOperationErrorCode } from './confirm-user-email/confirm-user-email.types'
export type { RevokeUserSessionsResult } from './revoke-user-sessions/revoke-user-sessions.types'
export { RevokeUserSessionsOperationErrorCode } from './revoke-user-sessions/revoke-user-sessions.types'
export type { UserDTO } from '../../managers/users-manager'

// 4. Union type
import type { ToggleUserActivationOperation } from './toggle-user-activation/toggle-user-activation.operation'
import type { ConfirmUserEmailOperation } from './confirm-user-email/confirm-user-email.operation'
import type { RevokeUserSessionsOperation } from './revoke-user-sessions/revoke-user-sessions.operation'

export type UserManagementOperations =
  | ToggleUserActivationOperation
  | ConfirmUserEmailOperation
  | RevokeUserSessionsOperation

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
