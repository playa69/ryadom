// 1. Handler imports
import './register/register.handler'
import './login/login.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { RegisterOperation } from './register/register.operation'
export type { RegisterOperationData } from './register/register.operation'
export { LoginOperation } from './login/login.operation'
export type { LoginOperationData } from './login/login.operation'

// 3. Type re-exports
export type { RegisterResult } from './register/register.types'
export { RegisterOperationErrorCode } from './register/register.types'
export type { LoginResult } from './login/login.types'
export { LoginOperationErrorCode } from './login/login.types'
export type { UserDTO } from '../../managers/users-manager'

// 4. Union type
import type { RegisterOperation } from './register/register.operation'
import type { LoginOperation } from './login/login.operation'

export type AuthenticationOperations =
  | RegisterOperation
  | LoginOperation

// 5. Facade
export class AuthenticationProcess implements IAuthenticationProcess {
  async execute<T extends AuthenticationOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: AuthenticationOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IAuthenticationProcess {
  execute<T extends AuthenticationOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const authenticationProcess: IAuthenticationProcess = new AuthenticationProcess()
