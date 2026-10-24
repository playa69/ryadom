import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { notificationDeliveries, notificationSettings, pushSubscriptions, widgetTokens } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DeleteUserNotificationsCommand } from './delete-user-notifications.command'
import { type DeleteUserNotificationsCommandResult } from './delete-user-notifications.types'

@requestHandler(DeleteUserNotificationsCommand)
export class DeleteUserNotificationsCommandHandler implements RequestHandler<DeleteUserNotificationsCommand, DeleteUserNotificationsCommandResult> {
  async handle(c: DeleteUserNotificationsCommand): Promise<DeleteUserNotificationsCommandResult> {
    // Account deletion: settings, devices, the delivery log and the widget tokens go before the row is anonymized.
    const db = getDb()
    await db.delete(notificationSettings).where(eq(notificationSettings.userId, c.userId))
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, c.userId))
    await db.delete(notificationDeliveries).where(eq(notificationDeliveries.userId, c.userId))
    await db.delete(widgetTokens).where(eq(widgetTokens.userId, c.userId))
    return { success: true }
  }
}
