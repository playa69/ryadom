import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { widgetTokens } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { CreateWidgetTokenCommand } from './create-widget-token.command'
import { type CreateWidgetTokenCommandResult } from './create-widget-token.types'

@requestHandler(CreateWidgetTokenCommand)
export class CreateWidgetTokenCommandHandler implements RequestHandler<CreateWidgetTokenCommand, CreateWidgetTokenCommandResult> {
  async handle(c: CreateWidgetTokenCommand): Promise<CreateWidgetTokenCommandResult> {
    // The token is shown once; the table keeps its hash. A person has one widget: a new token revokes the old one.
    const db = getDb()
    await db
      .update(widgetTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(widgetTokens.userId, c.userId), isNull(widgetTokens.revokedAt)))
    await db.insert(widgetTokens).values({ userId: c.userId, tokenHash: createHash('sha256').update(c.token).digest() })
    return { success: true }
  }
}
