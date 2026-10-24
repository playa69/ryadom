import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DeletePushSubscriptionCommand } from './delete-push-subscription.command'
import { DeletePushSubscriptionCommandErrorCode, type DeletePushSubscriptionCommandResult } from './delete-push-subscription.types'

@requestHandler(DeletePushSubscriptionCommand)
export class DeletePushSubscriptionCommandHandler implements RequestHandler<DeletePushSubscriptionCommand, DeletePushSubscriptionCommandResult> {
  async handle(c: DeletePushSubscriptionCommand): Promise<DeletePushSubscriptionCommandResult> {
    // `userId` is set when the person removes their own device; the scheduler removes a dead address by id alone.
    const rows = await getDb()
      .delete(pushSubscriptions)
      .where(c.userId ? and(eq(pushSubscriptions.id, c.id), eq(pushSubscriptions.userId, c.userId)) : eq(pushSubscriptions.id, c.id))
      .returning({ id: pushSubscriptions.id })
    if (rows.length === 0) return { success: false, error: DeletePushSubscriptionCommandErrorCode.SUBSCRIPTION_NOT_FOUND }
    return { success: true }
  }
}
