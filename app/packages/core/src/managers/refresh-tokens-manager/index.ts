// 1. Handler imports
import './commands/store-refresh-token/store-refresh-token.handler'
import './commands/revoke-refresh-token/revoke-refresh-token.handler'
import './commands/revoke-user-refresh-tokens/revoke-user-refresh-tokens.handler'
import './commands/revoke-session-refresh-tokens/revoke-session-refresh-tokens.handler'
import './commands/delete-expired-refresh-tokens/delete-expired-refresh-tokens.handler'
import './queries/get-refresh-token/get-refresh-token.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { StoreRefreshTokenCommand } from './commands/store-refresh-token/store-refresh-token.command'
export type { StoreRefreshTokenCommandData } from './commands/store-refresh-token/store-refresh-token.command'
export { RevokeRefreshTokenCommand } from './commands/revoke-refresh-token/revoke-refresh-token.command'
export type { RevokeRefreshTokenCommandData } from './commands/revoke-refresh-token/revoke-refresh-token.command'
export { RevokeUserRefreshTokensCommand } from './commands/revoke-user-refresh-tokens/revoke-user-refresh-tokens.command'
export type { RevokeUserRefreshTokensCommandData } from './commands/revoke-user-refresh-tokens/revoke-user-refresh-tokens.command'
export { RevokeSessionRefreshTokensCommand } from './commands/revoke-session-refresh-tokens/revoke-session-refresh-tokens.command'
export type { RevokeSessionRefreshTokensCommandData } from './commands/revoke-session-refresh-tokens/revoke-session-refresh-tokens.command'
export { DeleteExpiredRefreshTokensCommand } from './commands/delete-expired-refresh-tokens/delete-expired-refresh-tokens.command'
export type { DeleteExpiredRefreshTokensCommandData } from './commands/delete-expired-refresh-tokens/delete-expired-refresh-tokens.command'
export { GetRefreshTokenQuery } from './queries/get-refresh-token/get-refresh-token.query'
export type { GetRefreshTokenQueryData } from './queries/get-refresh-token/get-refresh-token.query'

// 3. Type re-exports
export type { StoreRefreshTokenCommandResult } from './commands/store-refresh-token/store-refresh-token.types'
export { StoreRefreshTokenCommandErrorCode } from './commands/store-refresh-token/store-refresh-token.types'
export type { RevokeRefreshTokenCommandResult } from './commands/revoke-refresh-token/revoke-refresh-token.types'
export { RevokeRefreshTokenCommandErrorCode } from './commands/revoke-refresh-token/revoke-refresh-token.types'
export type { RevokeUserRefreshTokensCommandResult } from './commands/revoke-user-refresh-tokens/revoke-user-refresh-tokens.types'
export type { RevokeSessionRefreshTokensCommandResult } from './commands/revoke-session-refresh-tokens/revoke-session-refresh-tokens.types'
export type { DeleteExpiredRefreshTokensCommandResult } from './commands/delete-expired-refresh-tokens/delete-expired-refresh-tokens.types'
export type { GetRefreshTokenQueryResult } from './queries/get-refresh-token/get-refresh-token.types'
export { GetRefreshTokenQueryErrorCode } from './queries/get-refresh-token/get-refresh-token.types'
export type { RefreshTokenDTO } from './shared/refresh-token.dto'

// 4. Union type
import type { StoreRefreshTokenCommand } from './commands/store-refresh-token/store-refresh-token.command'
import type { RevokeRefreshTokenCommand } from './commands/revoke-refresh-token/revoke-refresh-token.command'
import type { RevokeUserRefreshTokensCommand } from './commands/revoke-user-refresh-tokens/revoke-user-refresh-tokens.command'
import type { RevokeSessionRefreshTokensCommand } from './commands/revoke-session-refresh-tokens/revoke-session-refresh-tokens.command'
import type { DeleteExpiredRefreshTokensCommand } from './commands/delete-expired-refresh-tokens/delete-expired-refresh-tokens.command'
import type { GetRefreshTokenQuery } from './queries/get-refresh-token/get-refresh-token.query'

export type RefreshTokensManagerRequests =
  | StoreRefreshTokenCommand
  | RevokeRefreshTokenCommand
  | RevokeUserRefreshTokensCommand
  | RevokeSessionRefreshTokensCommand
  | DeleteExpiredRefreshTokensCommand
  | GetRefreshTokenQuery

// 5. Facade
export class RefreshTokensManager implements IRefreshTokensManager {
  async execute<T extends RefreshTokensManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: RefreshTokensManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IRefreshTokensManager {
  execute<T extends RefreshTokensManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const refreshTokensManager: IRefreshTokensManager = new RefreshTokensManager()
