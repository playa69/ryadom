// 1. Handler imports
import './request-admin-code/request-admin-code.handler'
import './confirm-admin-code/confirm-admin-code.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { RequestAdminCodeOperation } from './request-admin-code/request-admin-code.operation'
export type { RequestAdminCodeOperationData } from './request-admin-code/request-admin-code.operation'
export { ConfirmAdminCodeOperation } from './confirm-admin-code/confirm-admin-code.operation'
export type { ConfirmAdminCodeOperationData } from './confirm-admin-code/confirm-admin-code.operation'

// 3. Type re-exports
export type { RequestAdminCodeResult } from './request-admin-code/request-admin-code.types'
export type { ConfirmAdminCodeResult } from './confirm-admin-code/confirm-admin-code.types'
export { ConfirmAdminCodeOperationErrorCode } from './confirm-admin-code/confirm-admin-code.types'

// 4. Union type
import type { RequestAdminCodeOperation } from './request-admin-code/request-admin-code.operation'
import type { ConfirmAdminCodeOperation } from './confirm-admin-code/confirm-admin-code.operation'

export type AdminAuthenticationOperations = RequestAdminCodeOperation | ConfirmAdminCodeOperation

// 5. Facade
export class AdminAuthenticationProcess implements IAdminAuthenticationProcess {
  async execute<T extends AdminAuthenticationOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: AdminAuthenticationOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IAdminAuthenticationProcess {
  execute<T extends AdminAuthenticationOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const adminAuthenticationProcess: IAdminAuthenticationProcess = new AdminAuthenticationProcess()
