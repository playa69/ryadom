import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { DeletePushSubscriptionCommand, DeletePushSubscriptionCommandErrorCode, notificationsManager } from '../../../managers/notifications-manager'
import { DeleteSubscriptionOperation } from './delete-subscription.operation'
import { DeleteSubscriptionOperationErrorCode, type DeleteSubscriptionResult } from './delete-subscription.types'

@requestHandler(DeleteSubscriptionOperation)
export class DeleteSubscriptionOperationHandler implements RequestHandler<DeleteSubscriptionOperation, DeleteSubscriptionResult> {
  async handle(c: DeleteSubscriptionOperation): Promise<DeleteSubscriptionResult> {
    if (!/^[0-9a-f-]{36}$/i.test(c.id)) return { success: false, error: DeleteSubscriptionOperationErrorCode.SUBSCRIPTION_NOT_FOUND }
    const deleted = await notificationsManager.execute(new DeletePushSubscriptionCommand({ id: c.id, userId: c.userId }))
    if (deleted.success) return { success: true }
    switch (deleted.error) {
      case DeletePushSubscriptionCommandErrorCode.SUBSCRIPTION_NOT_FOUND:
        return { success: false, error: DeleteSubscriptionOperationErrorCode.SUBSCRIPTION_NOT_FOUND }
      default:
        return assertNever(deleted.error)
    }
  }
}
