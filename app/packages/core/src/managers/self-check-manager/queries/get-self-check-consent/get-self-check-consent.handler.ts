import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { desc, eq } from 'drizzle-orm'
import { selfCheckConsentEvents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { GetSelfCheckConsentQuery } from './get-self-check-consent.query'
import { type GetSelfCheckConsentQueryResult } from './get-self-check-consent.types'

/** The consent is in force when the person's latest event is `granted`; its version is returned. */
@requestHandler(GetSelfCheckConsentQuery)
export class GetSelfCheckConsentQueryHandler implements RequestHandler<
  GetSelfCheckConsentQuery,
  GetSelfCheckConsentQueryResult
> {
  async handle(c: GetSelfCheckConsentQuery): Promise<GetSelfCheckConsentQueryResult> {
    const [row] = await getDb()
      .select({ action: selfCheckConsentEvents.action, version: selfCheckConsentEvents.version })
      .from(selfCheckConsentEvents)
      .where(eq(selfCheckConsentEvents.userId, c.userId))
      .orderBy(desc(selfCheckConsentEvents.at))
      .limit(1)
    return { success: true, version: row?.action === 'granted' ? row.version : null }
  }
}
