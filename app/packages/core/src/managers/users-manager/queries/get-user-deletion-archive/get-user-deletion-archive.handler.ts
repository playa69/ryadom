import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { GetUserDeletionArchiveQuery } from './get-user-deletion-archive.query'
import {
  GetUserDeletionArchiveQueryErrorCode,
  type GetUserDeletionArchiveQueryResult,
} from './get-user-deletion-archive.types'
import { DELETION_ARCHIVE_KEY } from '../../shared/user.dto'

/** Personal data archive from `users.properties.deletion`; null means there is no archive yet. */
@requestHandler(GetUserDeletionArchiveQuery)
export class GetUserDeletionArchiveQueryHandler implements RequestHandler<
  GetUserDeletionArchiveQuery,
  GetUserDeletionArchiveQueryResult
> {
  async handle(query: GetUserDeletionArchiveQuery): Promise<GetUserDeletionArchiveQueryResult> {
    if (!isUuid(query.userId)) {
      return { success: false, error: GetUserDeletionArchiveQueryErrorCode.USER_NOT_FOUND }
    }
    const [row] = await getDb().select({ properties: users.properties }).from(users).where(eq(users.id, query.userId))
    if (!row) return { success: false, error: GetUserDeletionArchiveQueryErrorCode.USER_NOT_FOUND }
    const archive = row.properties?.[DELETION_ARCHIVE_KEY]
    return {
      success: true,
      archive: archive && typeof archive === 'object' ? (archive as Record<string, unknown>) : null,
    }
  }
}
