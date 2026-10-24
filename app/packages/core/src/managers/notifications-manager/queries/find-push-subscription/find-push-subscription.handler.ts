import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toPushSubscriptionDTO } from '../../shared/notifications.dto'
import { FindPushSubscriptionQuery } from './find-push-subscription.query'
import { type FindPushSubscriptionQueryResult } from './find-push-subscription.types'

@requestHandler(FindPushSubscriptionQuery)
export class FindPushSubscriptionQueryHandler implements RequestHandler<FindPushSubscriptionQuery, FindPushSubscriptionQueryResult> {
  async handle(c: FindPushSubscriptionQuery): Promise<FindPushSubscriptionQueryResult> {
    // A browser is told by its endpoint (whoever held it before loses it); a Telegram chat is one per person.
    const same =
      c.channel === 'web_push' && c.endpoint
        ? and(eq(pushSubscriptions.channel, c.channel), eq(pushSubscriptions.endpoint, c.endpoint))
        : and(eq(pushSubscriptions.userId, c.userId), eq(pushSubscriptions.channel, c.channel))
    const [row] = await getDb().select().from(pushSubscriptions).where(same).limit(1)
    return { success: true, subscription: row ? toPushSubscriptionDTO(row) : null }
  }
}
