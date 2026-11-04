import { randomUUID } from 'node:crypto'
import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import { validateInput } from '../../../shared'
import {
  GetPushSubscriptionByTokenQuery,
  GetPushSubscriptionByTokenQueryErrorCode,
  StorePushSubscriptionCommand,
  StorePushSubscriptionCommandErrorCode,
  pushSubscriptionsManager,
} from '../../../managers/push-subscriptions-manager'
import { SubscribePushDeviceOperation } from './subscribe-push-device.operation'
import {
  SubscribePushDeviceOperationErrorCode,
  type SubscribePushDeviceResult,
} from './subscribe-push-device.types'
import { subscribePushDeviceSchema } from './subscribe-push-device.validator'

/**
 * A device with notifications switched on tells the server where to send them. The app does it on every start and
 * sign-in and when the push service hands it a new token, so this is idempotent: the same token is one subscription,
 * and it moves to the account and session of the latest request.
 */
@requestHandler(SubscribePushDeviceOperation)
export class SubscribePushDeviceOperationHandler implements RequestHandler<
  SubscribePushDeviceOperation,
  SubscribePushDeviceResult
> {
  async handle(operation: SubscribePushDeviceOperation): Promise<SubscribePushDeviceResult> {
    const input = validateInput(subscribePushDeviceSchema, {
      channel: operation.channel,
      token: operation.token,
      projectId: operation.projectId,
      appId: operation.appId,
    })
    const stored = await pushSubscriptionsManager.execute(
      new StorePushSubscriptionCommand({
        subscriptionId: randomUUID(),
        userId: operation.userId,
        sessionId: operation.sessionId,
        ...input,
        now: new Date(),
      }),
    )
    if (!stored.success) {
      switch (stored.error) {
        case StorePushSubscriptionCommandErrorCode.USER_NOT_FOUND:
          return { success: false, error: SubscribePushDeviceOperationErrorCode.USER_NOT_FOUND }
        default:
          assertNever(stored.error)
      }
    }
    const found = await pushSubscriptionsManager.execute(
      new GetPushSubscriptionByTokenQuery({ channel: input.channel, token: input.token }),
    )
    if (!found.success) {
      switch (found.error) {
        // Only a sign-out of the same device racing its own subscription can get here, and then there is nothing to keep.
        case GetPushSubscriptionByTokenQueryErrorCode.SUBSCRIPTION_NOT_FOUND:
          throw new Error('A push subscription disappeared right after it was stored')
        default:
          assertNever(found.error)
      }
    }
    return { success: true, subscriptionId: found.subscription.id }
  }
}
