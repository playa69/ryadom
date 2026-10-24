import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq, sql } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { RecordPushResultCommand } from './record-push-result.command'
import { type RecordPushResultCommandResult } from './record-push-result.types'

@requestHandler(RecordPushResultCommand)
export class RecordPushResultCommandHandler implements RequestHandler<RecordPushResultCommand, RecordPushResultCommandResult> {
  async handle(c: RecordPushResultCommand): Promise<RecordPushResultCommandResult> {
    await getDb()
      .update(pushSubscriptions)
      .set(c.ok ? { lastSuccessAt: new Date(), failures: 0 } : { failures: sql`${pushSubscriptions.failures} + 1` })
      .where(eq(pushSubscriptions.id, c.id))
    return { success: true }
  }
}
