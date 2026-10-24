import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { FindWidgetTokenQuery, diaryManager } from '../../../managers/diary-manager'
import { ResolveWidgetTokenOperation } from './resolve-widget-token.operation'
import { type ResolveWidgetTokenResult } from './resolve-widget-token.types'

@requestHandler(ResolveWidgetTokenOperation)
export class ResolveWidgetTokenOperationHandler implements RequestHandler<ResolveWidgetTokenOperation, ResolveWidgetTokenResult> {
  async handle(c: ResolveWidgetTokenOperation): Promise<ResolveWidgetTokenResult> {
    const found = await diaryManager.execute(new FindWidgetTokenQuery({ token: c.token }))
    return { success: true, userId: found.userId }
  }
}
