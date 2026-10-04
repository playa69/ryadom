import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { desc, eq } from 'drizzle-orm'
import { userConsents } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { toUserConsentDTO } from '../../shared/user-consent.dto'
import { ListUserConsentsQuery } from './list-user-consents.query'
import type { ListUserConsentsQueryResult } from './list-user-consents.types'

@requestHandler(ListUserConsentsQuery)
export class ListUserConsentsQueryHandler implements RequestHandler<
  ListUserConsentsQuery,
  ListUserConsentsQueryResult
> {
  async handle(query: ListUserConsentsQuery): Promise<ListUserConsentsQueryResult> {
    if (!isUuid(query.userId)) return { success: true, consents: [] }
    const rows = await getDb()
      .select()
      .from(userConsents)
      .where(eq(userConsents.userId, query.userId))
      .orderBy(desc(userConsents.acceptedAt), desc(userConsents.id))
    return { success: true, consents: rows.map(toUserConsentDTO) }
  }
}
