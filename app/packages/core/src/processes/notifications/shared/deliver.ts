import assertNever from 'assert-never'
import { createLogger } from '../../../shared'
import {
  DeletePushSubscriptionCommand,
  DeletePushSubscriptionCommandErrorCode,
  pushSubscriptionsManager,
  type PushSubscriptionDTO,
} from '../../../managers/push-subscriptions-manager'
import {
  ruStorePushIntegration,
  SendRuStorePushRequest,
  SendRuStorePushRequestErrorCode,
} from '../../../integrations/rustore-push'

const logger = createLogger('notifications')

export interface NotificationMessage {
  title: string
  body: string
  /** A route of the app the tap opens; null opens the app where it would open anyway. */
  link: string | null
}

/** What became of one device: took it, has gone (its subscription is removed), or did not take it this time. */
export type DeliveryOutcome = 'sent' | 'gone' | 'failed'

/**
 * Sends one notification to one device and never throws: a notification goes along with something else, and a push
 * service that is down must not fail it. A device the push service no longer knows is unsubscribed here, so the next
 * notification does not try it again.
 */
export async function deliver(
  subscription: PushSubscriptionDTO,
  message: NotificationMessage,
): Promise<DeliveryOutcome> {
  try {
    switch (subscription.channel) {
      case 'rustore':
        return await deliverByRuStore(subscription, message)
      default:
        return assertNever(subscription.channel)
    }
  } catch (error) {
    logger.warn('Notification not delivered', error, {
      subscriptionId: subscription.id,
      channel: subscription.channel,
    })
    return 'failed'
  }
}

async function deliverByRuStore(
  subscription: PushSubscriptionDTO,
  message: NotificationMessage,
): Promise<DeliveryOutcome> {
  const result = await ruStorePushIntegration.execute(
    new SendRuStorePushRequest({
      projectId: subscription.projectId,
      token: subscription.token,
      title: message.title,
      body: message.body,
      // `link` is `PushDataKey.Link` of the contract the clients read; the core does not depend on it.
      data: message.link === null ? {} : { link: message.link },
    }),
  )
  if (result.success) return 'sent'
  switch (result.error) {
    case SendRuStorePushRequestErrorCode.TOKEN_NOT_FOUND:
      await forget(subscription)
      return 'gone'
    case SendRuStorePushRequestErrorCode.PROJECT_NOT_CONFIGURED:
      logger.warn('No service token for the push project of a device', undefined, {
        subscriptionId: subscription.id,
        projectId: subscription.projectId,
      })
      return 'failed'
    default:
      return assertNever(result.error)
  }
}

async function forget(subscription: PushSubscriptionDTO): Promise<void> {
  const removed = await pushSubscriptionsManager.execute(
    new DeletePushSubscriptionCommand({ subscriptionId: subscription.id, userId: null }),
  )
  if (!removed.success) {
    switch (removed.error) {
      // Signed out or unsubscribed while this was being sent: it is gone either way.
      case DeletePushSubscriptionCommandErrorCode.SUBSCRIPTION_NOT_FOUND:
        break
      default:
        assertNever(removed.error)
    }
  }
  logger.info('Push token no longer valid: the device is unsubscribed', {
    userId: subscription.userId,
    subscriptionId: subscription.id,
  })
}
