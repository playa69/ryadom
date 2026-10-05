// 1. Handler imports
import './register/register.handler'
import './login/login.handler'
import './device-login/device-login.handler'
import './link-email/link-email.handler'
import './record-activity/record-activity.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { RegisterOperation } from './register/register.operation'
export type { RegisterOperationData } from './register/register.operation'
export { LoginOperation } from './login/login.operation'
export type { LoginOperationData } from './login/login.operation'
export { DeviceLoginOperation } from './device-login/device-login.operation'
export type { DeviceLoginOperationData } from './device-login/device-login.operation'
export { LinkEmailOperation } from './link-email/link-email.operation'
export type { LinkEmailOperationData } from './link-email/link-email.operation'
export { RecordActivityOperation } from './record-activity/record-activity.operation'
export type { RecordActivityOperationData } from './record-activity/record-activity.operation'

// 3. Type re-exports
export type { RegisterResult } from './register/register.types'
export { RegisterOperationErrorCode } from './register/register.types'
export type { LoginResult } from './login/login.types'
export { LoginOperationErrorCode } from './login/login.types'
export type { DeviceLoginResult } from './device-login/device-login.types'
export { DeviceLoginOperationErrorCode } from './device-login/device-login.types'
export type { LinkEmailResult } from './link-email/link-email.types'
export { LinkEmailOperationErrorCode } from './link-email/link-email.types'
export type { RecordActivityResult } from './record-activity/record-activity.types'
export type { UserDTO } from '../../managers/users-manager'

// 4. Union type
import type { RegisterOperation } from './register/register.operation'
import type { LoginOperation } from './login/login.operation'
import type { DeviceLoginOperation } from './device-login/device-login.operation'
import type { LinkEmailOperation } from './link-email/link-email.operation'
import type { RecordActivityOperation } from './record-activity/record-activity.operation'

export type AuthenticationOperations =
  RegisterOperation | LoginOperation | DeviceLoginOperation | LinkEmailOperation | RecordActivityOperation

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
