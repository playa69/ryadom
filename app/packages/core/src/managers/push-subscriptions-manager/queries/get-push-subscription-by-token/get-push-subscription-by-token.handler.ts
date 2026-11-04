import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { pushSubscriptions } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toPushSubscriptionDTO } from '../../shared/push-subscription.dto'
import { GetPushSubscriptionByTokenQuery } from './get-push-subscription-by-token.query'
import {
  GetPushSubscriptionByTokenQueryErrorCode,
  type GetPushSubscriptionByTokenQueryResult,
} from './get-push-subscription-by-token.types'

@requestHandler(GetPushSubscriptionByTokenQuery)
export class GetPushSubscriptionByTokenQueryHandler implements RequestHandler<
  GetPushSubscriptionByTokenQuery,
  GetPushSubscriptionByTokenQueryResult
> {
  async handle(query: GetPushSubscriptionByTokenQuery): Promise<GetPushSubscriptionByTokenQueryResult> {
    const [row] = await getDb()
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.channel, query.channel), eq(pushSubscriptions.token, query.token)))
      .limit(1)
    if (!row)
      return { success: false, error: GetPushSubscriptionByTokenQueryErrorCode.SUBSCRIPTION_NOT_FOUND }
    return { success: true, subscription: toPushSubscriptionDTO(row) }
  }
}
