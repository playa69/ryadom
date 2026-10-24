import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { MarkReminderOpenedCommand, MarkReminderOpenedCommandErrorCode, notificationsManager } from '../../../managers/notifications-manager'
import { MarkReminderOpenedOperation } from './mark-reminder-opened.operation'
import { type MarkReminderOpenedResult } from './mark-reminder-opened.types'

@requestHandler(MarkReminderOpenedOperation)
export class MarkReminderOpenedOperationHandler implements RequestHandler<MarkReminderOpenedOperation, MarkReminderOpenedResult> {
  async handle(c: MarkReminderOpenedOperation): Promise<MarkReminderOpenedResult> {
    const marked = await notificationsManager.execute(
      new MarkReminderOpenedCommand({ userId: c.userId, deliveryId: c.deliveryId }),
    )
    if (!marked.success) {
      switch (marked.error) {
        // Not this person's, or opened already: the same answer, nothing to do.
        case MarkReminderOpenedCommandErrorCode.DELIVERY_NOT_FOUND:
          break
        default:
          assertNever(marked.error)
      }
    }
    return { success: true }
  }
}
