import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, lt, sql } from 'drizzle-orm'
import { selfCheckResults, userConsents } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { InsertSelfCheckResultCommand } from './insert-self-check-result.command'
import { type InsertSelfCheckResultCommandResult } from './insert-self-check-result.types'

@requestHandler(InsertSelfCheckResultCommand)
export class InsertSelfCheckResultCommandHandler implements RequestHandler<InsertSelfCheckResultCommand, InsertSelfCheckResultCommandResult> {
  async handle(c: InsertSelfCheckResultCommand): Promise<InsertSelfCheckResultCommandResult> {
    await getDb()
      .insert(selfCheckResults)
      .values({
        id: c.id,
        userId: c.userId,
        testId: c.testId,
        testVersion: c.testVersion,
        score: c.score,
        subscores: c.subscores,
        band: c.band,
        takenAt: c.takenAt,
      })
    return { success: true }
  }
}
