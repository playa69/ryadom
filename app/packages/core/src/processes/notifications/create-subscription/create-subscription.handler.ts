import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { randomUUID } from 'node:crypto'
import { CreatePushSubscriptionCommand, FindPushSubscriptionQuery, notificationsManager } from '../../../managers/notifications-manager'
import { findUser } from '../shared/find-user'
import { CreateSubscriptionOperation } from './create-subscription.operation'
import { CreateSubscriptionOperationErrorCode, type CreateSubscriptionResult } from './create-subscription.types'

@requestHandler(CreateSubscriptionOperation)
export class CreateSubscriptionOperationHandler implements RequestHandler<CreateSubscriptionOperation, CreateSubscriptionResult> {
  async handle(c: CreateSubscriptionOperation): Promise<CreateSubscriptionResult> {
    const user = await findUser(c.userId)
    if (!user) return { success: false, error: CreateSubscriptionOperationErrorCode.USER_NOT_FOUND }
    if (c.channel === 'web_push') {
      const valid = c.endpoint && c.p256dh && c.auth && /^https:\/\//.test(c.endpoint) && c.endpoint.length <= 2048
      if (!valid) return { success: false, error: CreateSubscriptionOperationErrorCode.INVALID_SUBSCRIPTION }
    }
    if (c.channel === 'telegram' && user.telegramId === null) {
      return { success: false, error: CreateSubscriptionOperationErrorCode.TELEGRAM_NOT_LINKED }
    }
    // The same browser (or the person's Telegram chat) keeps its row and its id; a new one gets an id here.
    const existing = await notificationsManager.execute(
      new FindPushSubscriptionQuery({ userId: c.userId, channel: c.channel, endpoint: c.endpoint }),
    )
    const id = existing.subscription?.id ?? randomUUID()
    await notificationsManager.execute(
      new CreatePushSubscriptionCommand({
        id,
        userId: c.userId,
        channel: c.channel,
        endpoint: c.endpoint,
        p256dh: c.p256dh,
        auth: c.auth,
        deviceLabel: c.deviceLabel?.slice(0, 80),
      }),
    )
    return { success: true, id }
  }
}
