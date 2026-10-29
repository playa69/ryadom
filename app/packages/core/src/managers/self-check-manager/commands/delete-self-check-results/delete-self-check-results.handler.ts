import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { selfCheckResults, userConsents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toSelfCheckResultDTO } from '../../shared/self-check.dto'
import { DeleteSelfCheckResultsCommand } from './delete-self-check-results.command'
import { type DeleteSelfCheckResultsCommandResult } from './delete-self-check-results.types'

@requestHandler(DeleteSelfCheckResultsCommand)
export class DeleteSelfCheckResultsCommandHandler implements RequestHandler<
  DeleteSelfCheckResultsCommand,
  DeleteSelfCheckResultsCommandResult
> {
  async handle(c: DeleteSelfCheckResultsCommand): Promise<DeleteSelfCheckResultsCommandResult> {
    // One result, all of one test, or (neither given) all of the person's results; always only the person's own.
    const where = and(
      eq(selfCheckResults.userId, c.userId),
      c.resultId ? eq(selfCheckResults.id, c.resultId) : undefined,
      c.testId ? eq(selfCheckResults.testId, c.testId) : undefined,
    )
    await getDb().delete(selfCheckResults).where(where)
    return { success: true }
  }
}
