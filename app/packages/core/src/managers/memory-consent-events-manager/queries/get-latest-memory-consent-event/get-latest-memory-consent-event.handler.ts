import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { desc, eq } from 'drizzle-orm'
import { memoryConsentEvents } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { toMemoryConsentEventDTO } from '../../shared/memory-consent-event.dto'
import { GetLatestMemoryConsentEventQuery } from './get-latest-memory-consent-event.query'
import type { GetLatestMemoryConsentEventQueryResult } from './get-latest-memory-consent-event.types'

@requestHandler(GetLatestMemoryConsentEventQuery)
export class GetLatestMemoryConsentEventQueryHandler implements RequestHandler<
  GetLatestMemoryConsentEventQuery,
  GetLatestMemoryConsentEventQueryResult
> {
  async handle(query: GetLatestMemoryConsentEventQuery): Promise<GetLatestMemoryConsentEventQueryResult> {
    if (!isUuid(query.userId)) return { success: true, event: null }
    const [row] = await getDb()
      .select()
      .from(memoryConsentEvents)
      .where(eq(memoryConsentEvents.userId, query.userId))
      .orderBy(desc(memoryConsentEvents.at), desc(memoryConsentEvents.id))
      .limit(1)
    return { success: true, event: row ? toMemoryConsentEventDTO(row) : null }
  }
}
