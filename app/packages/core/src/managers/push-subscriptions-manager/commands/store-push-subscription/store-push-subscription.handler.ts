import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { pushSubscriptions } from '@ryadom/db/schema'
import { isForeignKeyViolation, withSavepoint } from '../../../../shared'
import { StorePushSubscriptionCommand } from './store-push-subscription.command'
import {
  StorePushSubscriptionCommandErrorCode,
  type StorePushSubscriptionCommandResult,
} from './store-push-subscription.types'

/**
 * Upsert by the token: a token names one installation of the app, so a second registration of it is the same device,
 * maybe with another account or session on it now, and the row moves there instead of a second one appearing.
 */
@requestHandler(StorePushSubscriptionCommand)
export class StorePushSubscriptionCommandHandler implements RequestHandler<
  StorePushSubscriptionCommand,
  StorePushSubscriptionCommandResult
> {
  async handle(command: StorePushSubscriptionCommand): Promise<StorePushSubscriptionCommandResult> {
    const owner = {
      userId: command.userId,
      sessionId: command.sessionId,
      projectId: command.projectId,
      appId: command.appId,
      updatedAt: command.now,
    }
    try {
      // A savepoint: a foreign key failure would otherwise break the transaction the caller may be in.
      await withSavepoint((db) =>
        db
          .insert(pushSubscriptions)
          .values({
            id: command.subscriptionId,
            channel: command.channel,
            token: command.token,
            createdAt: command.now,
            ...owner,
          })
          .onConflictDoUpdate({ target: [pushSubscriptions.channel, pushSubscriptions.token], set: owner }),
      )
      return { success: true }
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        return { success: false, error: StorePushSubscriptionCommandErrorCode.USER_NOT_FOUND }
      }
      throw error
    }
  }
}
