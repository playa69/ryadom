import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { findUser } from '../shared/find-user'
import { readSettingsView } from '../shared/settings-view'
import { GetNotificationSettingsOperation } from './get-notification-settings.operation'
import { GetNotificationSettingsOperationErrorCode, type GetNotificationSettingsResult } from './get-notification-settings.types'

@requestHandler(GetNotificationSettingsOperation)
export class GetNotificationSettingsOperationHandler implements RequestHandler<GetNotificationSettingsOperation, GetNotificationSettingsResult> {
  async handle(c: GetNotificationSettingsOperation): Promise<GetNotificationSettingsResult> {
    if (!(await findUser(c.userId))) return { success: false, error: GetNotificationSettingsOperationErrorCode.USER_NOT_FOUND }
    return { success: true, ...(await readSettingsView(c.userId)) }
  }
}
