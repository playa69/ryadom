import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, ne } from 'drizzle-orm'
import { diarySummaries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
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
    await db.delete(diarySummaries).where(and(period, eq(diarySummaries.text, '')))
    await db.update(diarySummaries).set({ status: 'ready' }).where(and(period, ne(diarySummaries.text, '')))
    return { success: true }
  }
}
