import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { userCredentials } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { GetUserCredentialsQuery } from './get-user-credentials.query'
import { GetUserCredentialsQueryErrorCode, type GetUserCredentialsQueryResult } from './get-user-credentials.types'
import { toUserCredentialsDTO } from '../../shared/user-credentials.dto'

@requestHandler(GetUserCredentialsQuery)
export class GetUserCredentialsQueryHandler implements RequestHandler<
  GetUserCredentialsQuery,
  GetUserCredentialsQueryResult
> {
  async handle(query: GetUserCredentialsQuery): Promise<GetUserCredentialsQueryResult> {
    if (!isUuid(query.userId)) {
      return { success: false, error: GetUserCredentialsQueryErrorCode.CREDENTIALS_NOT_FOUND }
    }
    const [row] = await getDb().select().from(userCredentials).where(eq(userCredentials.userId, query.userId))
    if (!row) return { success: false, error: GetUserCredentialsQueryErrorCode.CREDENTIALS_NOT_FOUND }
    return { success: true, credentials: toUserCredentialsDTO(row) }
  }
}
