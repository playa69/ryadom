// 1. Handler imports
import './commands/create-email-code/create-email-code.handler'
import './commands/verify-email-code/verify-email-code.handler'
import './commands/delete-email-codes/delete-email-codes.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { CreateEmailCodeCommand } from './commands/create-email-code/create-email-code.command'
export type { CreateEmailCodeCommandData } from './commands/create-email-code/create-email-code.command'
export { VerifyEmailCodeCommand } from './commands/verify-email-code/verify-email-code.command'
export type { VerifyEmailCodeCommandData } from './commands/verify-email-code/verify-email-code.command'
export { DeleteEmailCodesCommand } from './commands/delete-email-codes/delete-email-codes.command'
export type { DeleteEmailCodesCommandData } from './commands/delete-email-codes/delete-email-codes.command'

// 3. Type re-exports
export type { CreateEmailCodeCommandResult } from './commands/create-email-code/create-email-code.types'
export type { VerifyEmailCodeCommandResult } from './commands/verify-email-code/verify-email-code.types'
export { VerifyEmailCodeCommandErrorCode } from './commands/verify-email-code/verify-email-code.types'
export type { DeleteEmailCodesCommandResult } from './commands/delete-email-codes/delete-email-codes.types'

// 4. Union type
import type { CreateEmailCodeCommand } from './commands/create-email-code/create-email-code.command'
import type { VerifyEmailCodeCommand } from './commands/verify-email-code/verify-email-code.command'
import type { DeleteEmailCodesCommand } from './commands/delete-email-codes/delete-email-codes.command'

export type EmailCodesManagerRequests = CreateEmailCodeCommand | VerifyEmailCodeCommand | DeleteEmailCodesCommand

// 5. Facade
export class EmailCodesManager implements IEmailCodesManager {
  async execute<T extends EmailCodesManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: EmailCodesManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IEmailCodesManager {
  execute<T extends EmailCodesManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const emailCodesManager: IEmailCodesManager = new EmailCodesManager()
