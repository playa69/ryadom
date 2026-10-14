import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toUserDTO } from '../../shared/user.dto'
import { GetUserByTelegramIdQuery } from './get-user-by-telegram-id.query'
import {
  GetUserByTelegramIdQueryErrorCode,
  type GetUserByTelegramIdQueryResult,
} from './get-user-by-telegram-id.types'

@requestHandler(GetUserByTelegramIdQuery)
export class GetUserByTelegramIdQueryHandler implements RequestHandler<
  GetUserByTelegramIdQuery,
  GetUserByTelegramIdQueryResult
> {
  async handle(query: GetUserByTelegramIdQuery): Promise<GetUserByTelegramIdQueryResult> {
    const [row] = await getDb().select().from(users).where(eq(users.telegramId, query.telegramId))
    if (!row) return { success: false, error: GetUserByTelegramIdQueryErrorCode.USER_NOT_FOUND }
    return { success: true, user: toUserDTO(row) }
  }
}
