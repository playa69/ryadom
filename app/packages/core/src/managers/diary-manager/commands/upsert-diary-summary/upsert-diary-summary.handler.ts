import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { diarySummaries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { UpsertDiarySummaryCommand } from './upsert-diary-summary.command'
import { type UpsertDiarySummaryCommandResult } from './upsert-diary-summary.types'

@requestHandler(UpsertDiarySummaryCommand)
export class UpsertDiarySummaryCommandHandler implements RequestHandler<UpsertDiarySummaryCommand, UpsertDiarySummaryCommandResult> {
  async handle(c: UpsertDiarySummaryCommand): Promise<UpsertDiarySummaryCommandResult> {
    // A new text for the same period replaces the old one.
    await getDb()
      .insert(diarySummaries)
      .values({
        userId: c.userId,
        kind: c.kind,
        periodStart: c.periodStart,
        text: c.text,
        stats: c.stats,
        generatedAt: c.generatedAt,
      })
      .onConflictDoUpdate({
        target: [diarySummaries.userId, diarySummaries.kind, diarySummaries.periodStart],
        set: { text: c.text, stats: c.stats, generatedAt: c.generatedAt },
      })
    return { success: true }
  }
}
