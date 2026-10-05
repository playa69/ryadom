// 1. Handler imports
import './confirm-email/confirm-email.handler'
import './resend-confirmation/resend-confirmation.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { ConfirmEmailOperation } from './confirm-email/confirm-email.operation'
export type { ConfirmEmailOperationData } from './confirm-email/confirm-email.operation'
export { ResendConfirmationOperation } from './resend-confirmation/resend-confirmation.operation'
export type { ResendConfirmationOperationData } from './resend-confirmation/resend-confirmation.operation'

// 3. Type re-exports
export type { ConfirmEmailResult } from './confirm-email/confirm-email.types'
export { ConfirmEmailOperationErrorCode } from './confirm-email/confirm-email.types'
export type { ResendConfirmationResult } from './resend-confirmation/resend-confirmation.types'

// 4. Union type
import type { ConfirmEmailOperation } from './confirm-email/confirm-email.operation'
import type { ResendConfirmationOperation } from './resend-confirmation/resend-confirmation.operation'

export type EmailConfirmationOperations =
  | ConfirmEmailOperation
  | ResendConfirmationOperation

// 5. Facade
export class EmailConfirmationProcess implements IEmailConfirmationProcess {
  async execute<T extends EmailConfirmationOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: EmailConfirmationOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IEmailConfirmationProcess {
  execute<T extends EmailConfirmationOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const emailConfirmationProcess: IEmailConfirmationProcess = new EmailConfirmationProcess()
