import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { notificationDeliveries } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { MarkReminderDeliveryCommand } from './mark-reminder-delivery.command'
import { type MarkReminderDeliveryCommandResult } from './mark-reminder-delivery.types'

@requestHandler(MarkReminderDeliveryCommand)
export class MarkReminderDeliveryCommandHandler implements RequestHandler<MarkReminderDeliveryCommand, MarkReminderDeliveryCommandResult> {
  async handle(c: MarkReminderDeliveryCommand): Promise<MarkReminderDeliveryCommandResult> {
    await getDb()
      .update(notificationDeliveries)
      .set({ error: c.error ?? null })
      .where(eq(notificationDeliveries.id, c.deliveryId))
    return { success: true }
  }
}
