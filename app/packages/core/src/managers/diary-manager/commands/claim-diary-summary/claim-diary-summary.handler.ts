import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { sql } from 'drizzle-orm'
import { diarySummaries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { ClaimDiarySummaryCommand } from './claim-diary-summary.command'
import { ClaimDiarySummaryCommandErrorCode, type ClaimDiarySummaryCommandResult } from './claim-diary-summary.types'

@requestHandler(ClaimDiarySummaryCommand)
export class ClaimDiarySummaryCommandHandler implements RequestHandler<ClaimDiarySummaryCommand, ClaimDiarySummaryCommandResult> {
  async handle(c: ClaimDiarySummaryCommand): Promise<ClaimDiarySummaryCommandResult> {
    // A new period is a `pending` row with no text. A text that is not final yet (made by the button
    // during the week) or a claim whose replica went away can be taken over; a final text or a fresh
    // claim cannot. One statement, so of several replicas exactly one gets a row back.
    const rows = await getDb()
      .insert(diarySummaries)
      .values({ userId: c.userId, kind: c.kind, periodStart: c.periodStart, text: '', status: 'pending', generatedAt: c.now })
      .onConflictDoUpdate({
        target: [diarySummaries.userId, diarySummaries.kind, diarySummaries.periodStart],
        set: { status: 'pending', generatedAt: c.now },
        setWhere: sql`(${diarySummaries.status} = 'ready' and coalesce((${diarySummaries.stats}->>'final')::boolean, false) = false)
          or (${diarySummaries.status} = 'pending' and ${diarySummaries.generatedAt} < ${c.staleBefore.toISOString()}::timestamptz)`,
      })
      .returning({ id: diarySummaries.id })
    return rows.length > 0 ? { success: true } : { success: false, error: ClaimDiarySummaryCommandErrorCode.ALREADY_CLAIMED }
  }
}
