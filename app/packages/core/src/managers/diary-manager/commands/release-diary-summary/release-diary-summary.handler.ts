import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, ne, sql } from 'drizzle-orm'
import { diarySummaries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { RECOMPUTE_MARKER_AT } from '../mark-diary-summary-for-recompute/mark-diary-summary-for-recompute.handler'
import { ReleaseDiarySummaryCommand } from './release-diary-summary.command'
import { type ReleaseDiarySummaryCommandResult } from './release-diary-summary.types'

@requestHandler(ReleaseDiarySummaryCommand)
export class ReleaseDiarySummaryCommandHandler implements RequestHandler<ReleaseDiarySummaryCommand, ReleaseDiarySummaryCommandResult> {
  async handle(c: ReleaseDiarySummaryCommand): Promise<ReleaseDiarySummaryCommandResult> {
    const db = getDb()
    const period = and(
      eq(diarySummaries.userId, c.userId),
      eq(diarySummaries.kind, c.kind),
      eq(diarySummaries.periodStart, c.periodStart),
      eq(diarySummaries.status, 'pending'),
    )
    // A recompute marker survives a failed attempt (it goes back to the epoch, claimable again); any other empty claim is dropped.
    const isMarker = sql`coalesce((${diarySummaries.stats}->>'recompute')::boolean, false) = true`
    await db
      .update(diarySummaries)
      .set({ generatedAt: RECOMPUTE_MARKER_AT })
      .where(and(period, eq(diarySummaries.text, ''), isMarker))
    await db.delete(diarySummaries).where(and(period, eq(diarySummaries.text, ''), sql`not (${isMarker})`))
    await db.update(diarySummaries).set({ status: 'ready' }).where(and(period, ne(diarySummaries.text, '')))
    return { success: true }
  }
}
