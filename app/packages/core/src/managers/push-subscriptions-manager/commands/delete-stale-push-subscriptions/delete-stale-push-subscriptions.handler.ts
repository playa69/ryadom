import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { not } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { sessionIsOpen } from '../../shared/open-session'
import { DeleteStalePushSubscriptionsCommand } from './delete-stale-push-subscriptions.command'
import type { DeleteStalePushSubscriptionsCommandResult } from './delete-stale-push-subscriptions.types'

/**
 * Sending skips these rows already; deleting them keeps the token of a device somebody left out of the database. A
 * device that comes back signs in again and subscribes again, from its new session.
 */
@requestHandler(DeleteStalePushSubscriptionsCommand)
export class DeleteStalePushSubscriptionsCommandHandler implements RequestHandler<
  DeleteStalePushSubscriptionsCommand,
  DeleteStalePushSubscriptionsCommandResult
> {
  async handle(
    command: DeleteStalePushSubscriptionsCommand,
  ): Promise<DeleteStalePushSubscriptionsCommandResult> {
    await getDb()
      .delete(pushSubscriptions)
      .where(not(sessionIsOpen(command.now)))
    return { success: true }
  }
}
