import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, isNull } from 'drizzle-orm'
import { widgetTokens } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { RevokeWidgetTokensCommand } from './revoke-widget-tokens.command'
import { type RevokeWidgetTokensCommandResult } from './revoke-widget-tokens.types'

@requestHandler(RevokeWidgetTokensCommand)
export class RevokeWidgetTokensCommandHandler implements RequestHandler<RevokeWidgetTokensCommand, RevokeWidgetTokensCommandResult> {
  async handle(c: RevokeWidgetTokensCommand): Promise<RevokeWidgetTokensCommandResult> {
    await getDb()
      .update(widgetTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(widgetTokens.userId, c.userId), isNull(widgetTokens.revokedAt)))
    return { success: true }
  }
}
