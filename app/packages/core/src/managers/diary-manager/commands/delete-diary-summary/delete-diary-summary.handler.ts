import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { diarySummaries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DeleteDiarySummaryCommand } from './delete-diary-summary.command'
import { type DeleteDiarySummaryCommandResult } from './delete-diary-summary.types'

@requestHandler(DeleteDiarySummaryCommand)
export class DeleteDiarySummaryCommandHandler implements RequestHandler<DeleteDiarySummaryCommand, DeleteDiarySummaryCommandResult> {
  async handle(c: DeleteDiarySummaryCommand): Promise<DeleteDiarySummaryCommandResult> {
    await getDb()
      .delete(diarySummaries)
      .where(
        and(
          eq(diarySummaries.userId, c.userId),
          eq(diarySummaries.kind, c.kind),
          eq(diarySummaries.periodStart, c.periodStart),
          eq(diarySummaries.status, c.status),
        ),
      )
    return { success: true }
  }
}
