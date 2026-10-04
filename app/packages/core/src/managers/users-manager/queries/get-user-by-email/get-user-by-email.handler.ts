import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { GetUserByEmailQuery } from './get-user-by-email.query'
import { GetUserByEmailQueryErrorCode, type GetUserByEmailQueryResult } from './get-user-by-email.types'
import { toUserDTO } from '../../shared/user.dto'

@requestHandler(GetUserByEmailQuery)
export class GetUserByEmailQueryHandler implements RequestHandler<GetUserByEmailQuery, GetUserByEmailQueryResult> {
  async handle(query: GetUserByEmailQuery): Promise<GetUserByEmailQueryResult> {
    const email = query.email.trim().toLowerCase()
    const [row] = await getDb().select().from(users).where(eq(users.email, email))
    if (!row) return { success: false, error: GetUserByEmailQueryErrorCode.USER_NOT_FOUND }
    return { success: true, user: toUserDTO(row) }
  }
}
