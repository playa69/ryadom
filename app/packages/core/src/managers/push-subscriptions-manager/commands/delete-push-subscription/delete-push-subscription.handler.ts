import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { DeletePushSubscriptionCommand } from './delete-push-subscription.command'
import {
  DeletePushSubscriptionCommandErrorCode,
  type DeletePushSubscriptionCommandResult,
} from './delete-push-subscription.types'

@requestHandler(DeletePushSubscriptionCommand)
export class DeletePushSubscriptionCommandHandler implements RequestHandler<
  DeletePushSubscriptionCommand,
  DeletePushSubscriptionCommandResult
> {
  async handle(command: DeletePushSubscriptionCommand): Promise<DeletePushSubscriptionCommandResult> {
    if (!isUuid(command.subscriptionId)) {
      return { success: false, error: DeletePushSubscriptionCommandErrorCode.SUBSCRIPTION_NOT_FOUND }
    }
    const rows = await getDb()
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.id, command.subscriptionId),
          command.userId === null ? undefined : eq(pushSubscriptions.userId, command.userId),
        ),
      )
      .returning({ id: pushSubscriptions.id })
    if (rows.length === 0) {
      return { success: false, error: DeletePushSubscriptionCommandErrorCode.SUBSCRIPTION_NOT_FOUND }
    }
    return { success: true }
  }
}
