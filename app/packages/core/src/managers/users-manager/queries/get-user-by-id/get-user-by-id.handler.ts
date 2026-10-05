import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { GetUserByIdQuery } from './get-user-by-id.query'
import { GetUserByIdQueryErrorCode, type GetUserByIdQueryResult } from './get-user-by-id.types'
import { toUserDTO } from '../../shared/user.dto'

@requestHandler(GetUserByIdQuery)
export class GetUserByIdQueryHandler implements RequestHandler<GetUserByIdQuery, GetUserByIdQueryResult> {
  async handle(query: GetUserByIdQuery): Promise<GetUserByIdQueryResult> {
    if (!isUuid(query.userId)) return { success: false, error: GetUserByIdQueryErrorCode.USER_NOT_FOUND }
    const [row] = await getDb().select().from(users).where(eq(users.id, query.userId))
    if (!row) return { success: false, error: GetUserByIdQueryErrorCode.USER_NOT_FOUND }
    return { success: true, user: toUserDTO(row) }
  }
}
