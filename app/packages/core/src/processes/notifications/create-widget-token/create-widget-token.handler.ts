import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { randomBytes } from 'node:crypto'
import { CreateWidgetTokenCommand, notificationsManager } from '../../../managers/notifications-manager'
import { findUser } from '../shared/find-user'
import { CreateWidgetTokenOperation } from './create-widget-token.operation'
import { CreateWidgetTokenOperationErrorCode, type CreateWidgetTokenResult } from './create-widget-token.types'

@requestHandler(CreateWidgetTokenOperation)
export class CreateWidgetTokenOperationHandler implements RequestHandler<CreateWidgetTokenOperation, CreateWidgetTokenResult> {
  async handle(c: CreateWidgetTokenOperation): Promise<CreateWidgetTokenResult> {
    if (!(await findUser(c.userId))) return { success: false, error: CreateWidgetTokenOperationErrorCode.USER_NOT_FOUND }
    // Only the hash is kept; the token is shown to the person once.
    const token = `wdg_${randomBytes(32).toString('base64url')}`
    await notificationsManager.execute(new CreateWidgetTokenCommand({ userId: c.userId, token }))
    return { success: true, token }
  }
}
