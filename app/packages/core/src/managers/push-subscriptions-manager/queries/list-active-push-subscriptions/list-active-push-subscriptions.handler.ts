import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { sessionIsOpen } from '../../shared/open-session'
import { toPushSubscriptionDTO } from '../../shared/push-subscription.dto'
import { ListActivePushSubscriptionsQuery } from './list-active-push-subscriptions.query'
import type { ListActivePushSubscriptionsQueryResult } from './list-active-push-subscriptions.types'

@requestHandler(ListActivePushSubscriptionsQuery)
export class ListActivePushSubscriptionsQueryHandler implements RequestHandler<
  ListActivePushSubscriptionsQuery,
  ListActivePushSubscriptionsQueryResult
> {
  async handle(query: ListActivePushSubscriptionsQuery): Promise<ListActivePushSubscriptionsQueryResult> {
    if (!isUuid(query.userId)) return { success: true, subscriptions: [] }
    const rows = await getDb()
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, query.userId), sessionIsOpen(query.now)))
      .orderBy(desc(pushSubscriptions.updatedAt))
    return { success: true, subscriptions: rows.map(toPushSubscriptionDTO) }
  }
}
