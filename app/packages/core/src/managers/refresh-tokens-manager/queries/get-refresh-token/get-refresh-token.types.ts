import type { RefreshTokenDTO } from '../../shared/refresh-token.dto'

export enum GetRefreshTokenQueryErrorCode {
  TOKEN_NOT_FOUND = 'TOKEN_NOT_FOUND',
}

export type GetRefreshTokenQueryResult =
  { success: true; token: RefreshTokenDTO } | { success: false; error: GetRefreshTokenQueryErrorCode }
