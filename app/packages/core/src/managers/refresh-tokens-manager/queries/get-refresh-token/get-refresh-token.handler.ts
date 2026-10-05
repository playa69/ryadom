import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { refreshTokens } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { toRefreshTokenDTO } from '../../shared/refresh-token.dto'
import { GetRefreshTokenQuery } from './get-refresh-token.query'
import { GetRefreshTokenQueryErrorCode, type GetRefreshTokenQueryResult } from './get-refresh-token.types'

@requestHandler(GetRefreshTokenQuery)
export class GetRefreshTokenQueryHandler implements RequestHandler<
  GetRefreshTokenQuery,
  GetRefreshTokenQueryResult
> {
  async handle(query: GetRefreshTokenQuery): Promise<GetRefreshTokenQueryResult> {
    if (!isUuid(query.tokenId))
      return { success: false, error: GetRefreshTokenQueryErrorCode.TOKEN_NOT_FOUND }
    const [row] = await getDb().select().from(refreshTokens).where(eq(refreshTokens.id, query.tokenId))
    if (!row) return { success: false, error: GetRefreshTokenQueryErrorCode.TOKEN_NOT_FOUND }
    return { success: true, token: toRefreshTokenDTO(row) }
  }
}
