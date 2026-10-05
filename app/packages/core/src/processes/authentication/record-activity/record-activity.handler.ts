import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { recordActivity } from '../shared/record-activity'
import { RecordActivityOperation } from './record-activity.operation'
import type { RecordActivityResult } from './record-activity.types'

/**
 * A session was renewed: the person is still there. Sign-in notes it itself, but a session lives
 * for weeks, and what the retention of anonymous accounts counts from is the last time anyone
 * opened the app, not the last time they signed in.
 */
@requestHandler(RecordActivityOperation)
export class RecordActivityOperationHandler implements RequestHandler<
  RecordActivityOperation,
  RecordActivityResult
> {
  async handle(operation: RecordActivityOperation): Promise<RecordActivityResult> {
    await recordActivity(operation.userId)
    return { success: true }
  }
}
