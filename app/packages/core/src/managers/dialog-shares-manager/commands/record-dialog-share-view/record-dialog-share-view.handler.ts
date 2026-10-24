import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq, sql } from 'drizzle-orm'
import { dialogShares } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { RecordDialogShareViewCommand } from './record-dialog-share-view.command'
import { type RecordDialogShareViewCommandResult } from './record-dialog-share-view.types'

/** The only trace of a visit: a counter and a time. No address, no User-Agent. */
@requestHandler(RecordDialogShareViewCommand)
export class RecordDialogShareViewCommandHandler implements RequestHandler<RecordDialogShareViewCommand, RecordDialogShareViewCommandResult> {
  async handle(command: RecordDialogShareViewCommand): Promise<RecordDialogShareViewCommandResult> {
    await getDb()
      .update(dialogShares)
      .set({ viewCount: sql`${dialogShares.viewCount} + 1`, lastViewedAt: command.now })
      .where(eq(dialogShares.id, command.id))
    return { success: true }
  }
}
