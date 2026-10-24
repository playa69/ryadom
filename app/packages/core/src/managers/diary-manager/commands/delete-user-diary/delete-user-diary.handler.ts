import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { diarySummaries, moodCheckins, widgetTokens } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DeleteUserDiaryCommand } from './delete-user-diary.command'
import { type DeleteUserDiaryCommandResult } from './delete-user-diary.types'

@requestHandler(DeleteUserDiaryCommand)
export class DeleteUserDiaryCommandHandler implements RequestHandler<DeleteUserDiaryCommand, DeleteUserDiaryCommandResult> {
  async handle(c: DeleteUserDiaryCommand): Promise<DeleteUserDiaryCommandResult> {
    // Account deletion: the row is only anonymized, so the person's notes, texts and widget tokens are removed by hand.
    const db = getDb()
    await db.delete(moodCheckins).where(eq(moodCheckins.userId, c.userId))
    await db.delete(diarySummaries).where(eq(diarySummaries.userId, c.userId))
    await db.delete(widgetTokens).where(eq(widgetTokens.userId, c.userId))
    return { success: true }
  }
}
