import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { notificationsManager, RevokeWidgetTokensCommand } from '../../../managers/notifications-manager'
import { RevokeWidgetTokenOperation } from './revoke-widget-token.operation'
import { type RevokeWidgetTokenResult } from './revoke-widget-token.types'

@requestHandler(RevokeWidgetTokenOperation)
export class RevokeWidgetTokenOperationHandler implements RequestHandler<RevokeWidgetTokenOperation, RevokeWidgetTokenResult> {
  async handle(c: RevokeWidgetTokenOperation): Promise<RevokeWidgetTokenResult> {
    await notificationsManager.execute(new RevokeWidgetTokensCommand({ userId: c.userId }))
    return { success: true }
  }
}
