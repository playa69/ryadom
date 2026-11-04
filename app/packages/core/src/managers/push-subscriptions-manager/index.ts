// 1. Handler imports
import './commands/store-push-subscription/store-push-subscription.handler'
import './commands/delete-push-subscription/delete-push-subscription.handler'
import './commands/delete-user-push-subscriptions/delete-user-push-subscriptions.handler'
import './commands/delete-stale-push-subscriptions/delete-stale-push-subscriptions.handler'
import './queries/get-push-subscription-by-token/get-push-subscription-by-token.handler'
import './queries/list-active-push-subscriptions/list-active-push-subscriptions.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { StorePushSubscriptionCommand } from './commands/store-push-subscription/store-push-subscription.command'
export type { StorePushSubscriptionCommandData } from './commands/store-push-subscription/store-push-subscription.command'
export { DeletePushSubscriptionCommand } from './commands/delete-push-subscription/delete-push-subscription.command'
export type { DeletePushSubscriptionCommandData } from './commands/delete-push-subscription/delete-push-subscription.command'
export { DeleteUserPushSubscriptionsCommand } from './commands/delete-user-push-subscriptions/delete-user-push-subscriptions.command'
export type { DeleteUserPushSubscriptionsCommandData } from './commands/delete-user-push-subscriptions/delete-user-push-subscriptions.command'
export { DeleteStalePushSubscriptionsCommand } from './commands/delete-stale-push-subscriptions/delete-stale-push-subscriptions.command'
export type { DeleteStalePushSubscriptionsCommandData } from './commands/delete-stale-push-subscriptions/delete-stale-push-subscriptions.command'
export { GetPushSubscriptionByTokenQuery } from './queries/get-push-subscription-by-token/get-push-subscription-by-token.query'
export type { GetPushSubscriptionByTokenQueryData } from './queries/get-push-subscription-by-token/get-push-subscription-by-token.query'
export { ListActivePushSubscriptionsQuery } from './queries/list-active-push-subscriptions/list-active-push-subscriptions.query'
export type { ListActivePushSubscriptionsQueryData } from './queries/list-active-push-subscriptions/list-active-push-subscriptions.query'

// 3. Type re-exports
export type { StorePushSubscriptionCommandResult } from './commands/store-push-subscription/store-push-subscription.types'
export { StorePushSubscriptionCommandErrorCode } from './commands/store-push-subscription/store-push-subscription.types'
export type { DeletePushSubscriptionCommandResult } from './commands/delete-push-subscription/delete-push-subscription.types'
export { DeletePushSubscriptionCommandErrorCode } from './commands/delete-push-subscription/delete-push-subscription.types'
export type { DeleteUserPushSubscriptionsCommandResult } from './commands/delete-user-push-subscriptions/delete-user-push-subscriptions.types'
export type { DeleteStalePushSubscriptionsCommandResult } from './commands/delete-stale-push-subscriptions/delete-stale-push-subscriptions.types'
export type { GetPushSubscriptionByTokenQueryResult } from './queries/get-push-subscription-by-token/get-push-subscription-by-token.types'
export { GetPushSubscriptionByTokenQueryErrorCode } from './queries/get-push-subscription-by-token/get-push-subscription-by-token.types'
export type { ListActivePushSubscriptionsQueryResult } from './queries/list-active-push-subscriptions/list-active-push-subscriptions.types'
export type { PushSubscriptionDTO } from './shared/push-subscription.dto'
export { PUSH_CHANNELS, type PushChannel } from '@ryadom/db/schema'

// 4. Union type
import type { StorePushSubscriptionCommand } from './commands/store-push-subscription/store-push-subscription.command'
import type { DeletePushSubscriptionCommand } from './commands/delete-push-subscription/delete-push-subscription.command'
import type { DeleteUserPushSubscriptionsCommand } from './commands/delete-user-push-subscriptions/delete-user-push-subscriptions.command'
import type { DeleteStalePushSubscriptionsCommand } from './commands/delete-stale-push-subscriptions/delete-stale-push-subscriptions.command'
import type { GetPushSubscriptionByTokenQuery } from './queries/get-push-subscription-by-token/get-push-subscription-by-token.query'
import type { ListActivePushSubscriptionsQuery } from './queries/list-active-push-subscriptions/list-active-push-subscriptions.query'

export type PushSubscriptionsManagerRequests =
  | StorePushSubscriptionCommand
  | DeletePushSubscriptionCommand
  | DeleteUserPushSubscriptionsCommand
  | DeleteStalePushSubscriptionsCommand
  | GetPushSubscriptionByTokenQuery
  | ListActivePushSubscriptionsQuery

// 5. Facade
export class PushSubscriptionsManager implements IPushSubscriptionsManager {
  async execute<T extends PushSubscriptionsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: PushSubscriptionsManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IPushSubscriptionsManager {
  execute<T extends PushSubscriptionsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never>
}

export const pushSubscriptionsManager: IPushSubscriptionsManager = new PushSubscriptionsManager()
