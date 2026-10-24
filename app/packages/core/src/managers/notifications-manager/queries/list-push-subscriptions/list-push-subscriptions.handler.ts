import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { asc, eq } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toPushSubscriptionDTO } from '../../shared/notifications.dto'
import { ListPushSubscriptionsQuery } from './list-push-subscriptions.query'
import { type ListPushSubscriptionsQueryResult } from './list-push-subscriptions.types'

@requestHandler(ListPushSubscriptionsQuery)
export class ListPushSubscriptionsQueryHandler implements RequestHandler<ListPushSubscriptionsQuery, ListPushSubscriptionsQueryResult> {
  async handle(c: ListPushSubscriptionsQuery): Promise<ListPushSubscriptionsQueryResult> {
    const rows = await getDb()
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, c.userId))
      .orderBy(asc(pushSubscriptions.createdAt))
    return { success: true, subscriptions: rows.map(toPushSubscriptionDTO) }
  }
}
