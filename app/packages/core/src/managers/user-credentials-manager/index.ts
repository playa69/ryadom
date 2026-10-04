// 1. Handler imports
import './commands/store-user-credentials/store-user-credentials.handler'
import './commands/update-user-credentials/update-user-credentials.handler'
import './commands/delete-user-credentials/delete-user-credentials.handler'
import './queries/get-user-credentials/get-user-credentials.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { StoreUserCredentialsCommand } from './commands/store-user-credentials/store-user-credentials.command'
export type { StoreUserCredentialsCommandData } from './commands/store-user-credentials/store-user-credentials.command'
export { UpdateUserCredentialsCommand } from './commands/update-user-credentials/update-user-credentials.command'
export type { UpdateUserCredentialsCommandData } from './commands/update-user-credentials/update-user-credentials.command'
export { DeleteUserCredentialsCommand } from './commands/delete-user-credentials/delete-user-credentials.command'
export type { DeleteUserCredentialsCommandData } from './commands/delete-user-credentials/delete-user-credentials.command'
export { GetUserCredentialsQuery } from './queries/get-user-credentials/get-user-credentials.query'
export type { GetUserCredentialsQueryData } from './queries/get-user-credentials/get-user-credentials.query'

// 3. Type re-exports
export type { StoreUserCredentialsCommandResult } from './commands/store-user-credentials/store-user-credentials.types'
export { StoreUserCredentialsCommandErrorCode } from './commands/store-user-credentials/store-user-credentials.types'
export type { UpdateUserCredentialsCommandResult } from './commands/update-user-credentials/update-user-credentials.types'
export { UpdateUserCredentialsCommandErrorCode } from './commands/update-user-credentials/update-user-credentials.types'
export type { DeleteUserCredentialsCommandResult } from './commands/delete-user-credentials/delete-user-credentials.types'
export type { GetUserCredentialsQueryResult } from './queries/get-user-credentials/get-user-credentials.types'
export { GetUserCredentialsQueryErrorCode } from './queries/get-user-credentials/get-user-credentials.types'
export type { UserCredentialsDTO } from './shared/user-credentials.dto'

// 4. Union type
import type { StoreUserCredentialsCommand } from './commands/store-user-credentials/store-user-credentials.command'
import type { UpdateUserCredentialsCommand } from './commands/update-user-credentials/update-user-credentials.command'
import type { DeleteUserCredentialsCommand } from './commands/delete-user-credentials/delete-user-credentials.command'
import type { GetUserCredentialsQuery } from './queries/get-user-credentials/get-user-credentials.query'

export type UserCredentialsManagerRequests =
  | StoreUserCredentialsCommand
  | UpdateUserCredentialsCommand
  | DeleteUserCredentialsCommand
  | GetUserCredentialsQuery

// 5. Facade
export class UserCredentialsManager implements IUserCredentialsManager {
  async execute<T extends UserCredentialsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: UserCredentialsManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IUserCredentialsManager {
  execute<T extends UserCredentialsManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const userCredentialsManager: IUserCredentialsManager = new UserCredentialsManager()
