import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { users, widgetTokens } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { FindWidgetTokenQuery } from './find-widget-token.query'
import { type FindWidgetTokenQueryResult } from './find-widget-token.types'

@requestHandler(FindWidgetTokenQuery)
export class FindWidgetTokenQueryHandler implements RequestHandler<FindWidgetTokenQuery, FindWidgetTokenQueryResult> {
  async handle(c: FindWidgetTokenQuery): Promise<FindWidgetTokenQueryResult> {
    // The user a widget token belongs to; null for an unknown, revoked or blocked one.
    const [row] = await getDb()
      .select({ userId: widgetTokens.userId, isActive: users.isActive, isDeleted: users.isDeleted })
      .from(widgetTokens)
      .innerJoin(users, eq(users.id, widgetTokens.userId))
      .where(and(eq(widgetTokens.tokenHash, createHash('sha256').update(c.token).digest()), isNull(widgetTokens.revokedAt)))
      .limit(1)
    return { success: true, userId: row && row.isActive && !row.isDeleted ? row.userId : null }
  }
}
