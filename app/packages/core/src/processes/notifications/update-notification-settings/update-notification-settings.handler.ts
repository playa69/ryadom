import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { notificationsManager, UpdateNotificationSettingsCommand } from '../../../managers/notifications-manager'
import { findUser } from '../shared/find-user'
import { isValidReminderTime } from '../shared/reminder-rules'
import { readSettingsView } from '../shared/settings-view'
import { UpdateNotificationSettingsOperation } from './update-notification-settings.operation'
import { UpdateNotificationSettingsOperationErrorCode, type UpdateNotificationSettingsResult } from './update-notification-settings.types'

@requestHandler(UpdateNotificationSettingsOperation)
export class UpdateNotificationSettingsOperationHandler implements RequestHandler<UpdateNotificationSettingsOperation, UpdateNotificationSettingsResult> {
  async handle(c: UpdateNotificationSettingsOperation): Promise<UpdateNotificationSettingsResult> {
    if (c.time !== undefined && !isValidReminderTime(c.time)) {
      return { success: false, error: UpdateNotificationSettingsOperationErrorCode.INVALID_TIME }
    }
    if (!(await findUser(c.userId))) return { success: false, error: UpdateNotificationSettingsOperationErrorCode.USER_NOT_FOUND }
    await notificationsManager.execute(
      new UpdateNotificationSettingsCommand({ userId: c.userId, enabled: c.enabled, time: c.time, offerAnswered: c.offerAnswered }),
    )
    return { success: true, ...(await readSettingsView(c.userId)) }
  }
}
