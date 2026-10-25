import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { diarySummaries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { MarkDiarySummaryForRecomputeCommand } from './mark-diary-summary-for-recompute.command'
import { type MarkDiarySummaryForRecomputeCommandResult } from './mark-diary-summary-for-recompute.types'

/** The epoch: older than any `staleBefore`, so a claim takes the marker over at once. */
export const RECOMPUTE_MARKER_AT = new Date(0)

@requestHandler(MarkDiarySummaryForRecomputeCommand)
export class MarkDiarySummaryForRecomputeCommandHandler implements RequestHandler<MarkDiarySummaryForRecomputeCommand, MarkDiarySummaryForRecomputeCommandResult> {
  async handle(c: MarkDiarySummaryForRecomputeCommand): Promise<MarkDiarySummaryForRecomputeCommandResult> {
    await getDb()
      .insert(diarySummaries)
      .values({
        userId: c.userId,
        kind: c.kind,
        periodStart: c.periodStart,
        text: '',
        status: 'pending',
        stats: { recompute: true },
        generatedAt: RECOMPUTE_MARKER_AT,
      })
      .onConflictDoNothing()
    return { success: true }
  }
}
