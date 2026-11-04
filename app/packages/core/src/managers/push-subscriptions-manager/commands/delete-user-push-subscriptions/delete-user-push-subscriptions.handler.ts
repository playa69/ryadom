import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DeleteUserPushSubscriptionsCommand } from './delete-user-push-subscriptions.command'
import type { DeleteUserPushSubscriptionsCommandResult } from './delete-user-push-subscriptions.types'

@requestHandler(DeleteUserPushSubscriptionsCommand)
export class DeleteUserPushSubscriptionsCommandHandler implements RequestHandler<
  DeleteUserPushSubscriptionsCommand,
  DeleteUserPushSubscriptionsCommandResult
> {
  async handle(
    command: DeleteUserPushSubscriptionsCommand,
  ): Promise<DeleteUserPushSubscriptionsCommandResult> {
    await getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.userId, command.userId))
    return { success: true }
  }
}
