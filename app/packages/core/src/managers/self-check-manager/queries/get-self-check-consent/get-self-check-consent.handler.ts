import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { selfCheckResults, userConsents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toSelfCheckResultDTO } from '../../shared/self-check.dto'
import { GetSelfCheckConsentQuery } from './get-self-check-consent.query'
import { type GetSelfCheckConsentQueryResult } from './get-self-check-consent.types'

@requestHandler(GetSelfCheckConsentQuery)
export class GetSelfCheckConsentQueryHandler implements RequestHandler<GetSelfCheckConsentQuery, GetSelfCheckConsentQueryResult> {
  async handle(c: GetSelfCheckConsentQuery): Promise<GetSelfCheckConsentQueryResult> {
    const [row] = await getDb()
      .select({ version: userConsents.version })
      .from(userConsents)
      .where(and(eq(userConsents.userId, c.userId), eq(userConsents.kind, 'self_check')))
      .orderBy(desc(userConsents.acceptedAt))
      .limit(1)
    return { success: true, version: row?.version ?? null }
  }
}
