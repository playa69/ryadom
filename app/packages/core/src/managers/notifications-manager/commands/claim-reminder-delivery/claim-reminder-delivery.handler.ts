import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { notificationDeliveries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { MOOD_DELIVERY_KIND } from '../../shared/notifications.dto'
import { ClaimReminderDeliveryCommand } from './claim-reminder-delivery.command'
import { ClaimReminderDeliveryCommandErrorCode, type ClaimReminderDeliveryCommandResult } from './claim-reminder-delivery.types'

@requestHandler(ClaimReminderDeliveryCommand)
export class ClaimReminderDeliveryCommandHandler implements RequestHandler<ClaimReminderDeliveryCommand, ClaimReminderDeliveryCommandResult> {
  async handle(c: ClaimReminderDeliveryCommand): Promise<ClaimReminderDeliveryCommandResult> {
    // The unique key (person, kind, local day) lets exactly one inserter win, whatever the number of replicas.
    const [row] = await getDb()
      .insert(notificationDeliveries)
      .values({ userId: c.userId, kind: MOOD_DELIVERY_KIND, localDate: c.localDate, channel: c.channel })
      .onConflictDoNothing()
      .returning({ id: notificationDeliveries.id })
    if (!row) return { success: false, error: ClaimReminderDeliveryCommandErrorCode.ALREADY_CLAIMED }
    return { success: true }
  }
}
