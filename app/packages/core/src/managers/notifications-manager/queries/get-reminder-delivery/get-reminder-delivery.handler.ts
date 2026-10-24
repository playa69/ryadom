import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { notificationDeliveries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { MOOD_DELIVERY_KIND } from '../../shared/notifications.dto'
import { GetReminderDeliveryQuery } from './get-reminder-delivery.query'
import { type GetReminderDeliveryQueryResult } from './get-reminder-delivery.types'

@requestHandler(GetReminderDeliveryQuery)
export class GetReminderDeliveryQueryHandler implements RequestHandler<GetReminderDeliveryQuery, GetReminderDeliveryQueryResult> {
  async handle(c: GetReminderDeliveryQuery): Promise<GetReminderDeliveryQueryResult> {
    const [row] = await getDb()
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.userId, c.userId),
          eq(notificationDeliveries.kind, MOOD_DELIVERY_KIND),
          eq(notificationDeliveries.localDate, c.localDate),
        ),
      )
      .limit(1)
    return { success: true, deliveryId: row?.id ?? null }
  }
}
