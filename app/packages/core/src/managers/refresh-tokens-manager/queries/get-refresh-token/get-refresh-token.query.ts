import { RequestData } from 'mediatr-ts'
import type { GetRefreshTokenQueryResult } from './get-refresh-token.types'

export interface GetRefreshTokenQueryData {
  tokenId: string
}

export class GetRefreshTokenQuery extends RequestData<GetRefreshTokenQueryResult> {
  /** Survives minification: GetRefreshTokenQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetRefreshTokenQuery'

  public readonly tokenId: string

  constructor(data: GetRefreshTokenQueryData) {
    super()
    this.tokenId = data.tokenId
  }
}
