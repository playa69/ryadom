import type { PushSubscriptionDTO } from '../../shared/push-subscription.dto'

export type ListActivePushSubscriptionsQueryResult = { success: true; subscriptions: PushSubscriptionDTO[] }
