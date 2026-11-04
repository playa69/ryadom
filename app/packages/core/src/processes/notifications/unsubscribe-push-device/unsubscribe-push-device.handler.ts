import { requestHandler, type RequestHandler } from 'mediatr-ts'
import assertNever from 'assert-never'
import {
  DeletePushSubscriptionCommand,
  DeletePushSubscriptionCommandErrorCode,
  pushSubscriptionsManager,
} from '../../../managers/push-subscriptions-manager'
import { UnsubscribePushDeviceOperation } from './unsubscribe-push-device.operation'
import {
  UnsubscribePushDeviceOperationErrorCode,
  type UnsubscribePushDeviceResult,
} from './unsubscribe-push-device.types'

/** Notifications switched off on a device, or the person signing out of it: only one of their own subscriptions. */
@requestHandler(UnsubscribePushDeviceOperation)
export class UnsubscribePushDeviceOperationHandler implements RequestHandler<
  UnsubscribePushDeviceOperation,
  UnsubscribePushDeviceResult
> {
  async handle(operation: UnsubscribePushDeviceOperation): Promise<UnsubscribePushDeviceResult> {
    const removed = await pushSubscriptionsManager.execute(
      new DeletePushSubscriptionCommand({
        subscriptionId: operation.subscriptionId,
        userId: operation.userId,
      }),
    )
    if (!removed.success) {
      switch (removed.error) {
        case DeletePushSubscriptionCommandErrorCode.SUBSCRIPTION_NOT_FOUND:
          return { success: false, error: UnsubscribePushDeviceOperationErrorCode.SUBSCRIPTION_NOT_FOUND }
        default:
          assertNever(removed.error)
      }
    }
    return { success: true }
  }
}
