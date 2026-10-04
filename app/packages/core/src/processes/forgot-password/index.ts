// 1. Handler imports
import './forgot-password/forgot-password.handler'
import './reset-password/reset-password.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { ForgotPasswordOperation } from './forgot-password/forgot-password.operation'
export type { ForgotPasswordOperationData } from './forgot-password/forgot-password.operation'
export { ResetPasswordOperation } from './reset-password/reset-password.operation'
export type { ResetPasswordOperationData } from './reset-password/reset-password.operation'

// 3. Type re-exports
export type { ForgotPasswordResult } from './forgot-password/forgot-password.types'
export type { ResetPasswordResult } from './reset-password/reset-password.types'
export { ResetPasswordOperationErrorCode } from './reset-password/reset-password.types'

// 4. Union type
import type { ForgotPasswordOperation } from './forgot-password/forgot-password.operation'
import type { ResetPasswordOperation } from './reset-password/reset-password.operation'

export type ForgotPasswordOperations = ForgotPasswordOperation | ResetPasswordOperation

// 5. Facade
export class ForgotPasswordProcess implements IForgotPasswordProcess {
  async execute<T extends ForgotPasswordOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: ForgotPasswordOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IForgotPasswordProcess {
  execute<T extends ForgotPasswordOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const forgotPasswordProcess: IForgotPasswordProcess = new ForgotPasswordProcess()
