import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { diaryManager, RevokeWidgetTokensCommand } from '../../../managers/diary-manager'
import { RevokeWidgetTokenOperation } from './revoke-widget-token.operation'
import { type RevokeWidgetTokenResult } from './revoke-widget-token.types'

@requestHandler(RevokeWidgetTokenOperation)
export class RevokeWidgetTokenOperationHandler implements RequestHandler<RevokeWidgetTokenOperation, RevokeWidgetTokenResult> {
  async handle(c: RevokeWidgetTokenOperation): Promise<RevokeWidgetTokenResult> {
    await diaryManager.execute(new RevokeWidgetTokensCommand({ userId: c.userId }))
    return { success: true }
  }
}
