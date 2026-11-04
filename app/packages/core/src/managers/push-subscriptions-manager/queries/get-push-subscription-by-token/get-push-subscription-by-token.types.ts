import type { PushSubscriptionDTO } from '../../shared/push-subscription.dto'

export enum GetPushSubscriptionByTokenQueryErrorCode {
  SUBSCRIPTION_NOT_FOUND = 'SUBSCRIPTION_NOT_FOUND',
}

export type GetPushSubscriptionByTokenQueryResult =
  | { success: true; subscription: PushSubscriptionDTO }
  | { success: false; error: GetPushSubscriptionByTokenQueryErrorCode }
