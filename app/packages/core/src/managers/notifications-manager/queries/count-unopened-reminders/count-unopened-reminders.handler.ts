import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, gt } from 'drizzle-orm'
import { notificationDeliveries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { MOOD_DELIVERY_KIND } from '../../shared/notifications.dto'
import { CountUnopenedRemindersQuery } from './count-unopened-reminders.query'
import { type CountUnopenedRemindersQueryResult } from './count-unopened-reminders.types'

@requestHandler(CountUnopenedRemindersQuery)
export class CountUnopenedRemindersQueryHandler implements RequestHandler<CountUnopenedRemindersQuery, CountUnopenedRemindersQueryResult> {
  async handle(c: CountUnopenedRemindersQuery): Promise<CountUnopenedRemindersQueryResult> {
    // Unopened deliveries in a row, newest first, counted from `since` (the last «Return»).
    const rows = await getDb()
      .select({ openedAt: notificationDeliveries.openedAt })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.userId, c.userId),
          eq(notificationDeliveries.kind, MOOD_DELIVERY_KIND),
          c.since ? gt(notificationDeliveries.sentAt, c.since) : undefined,
        ),
      )
      .orderBy(desc(notificationDeliveries.sentAt))
      .limit(c.limit)
    let unopenedInRow = 0
    for (const row of rows) {
      if (row.openedAt) break
      unopenedInRow += 1
    }
    return { success: true, unopenedInRow }
  }
}
