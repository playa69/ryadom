import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { dialogShares } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toDialogShareDTO } from '../../shared/dialog-share.dto'
import { GetActiveDialogShareQuery } from './get-active-dialog-share.query'
import { type GetActiveDialogShareQueryResult } from './get-active-dialog-share.types'


@requestHandler(GetActiveDialogShareQuery)
export class GetActiveDialogShareQueryHandler implements RequestHandler<GetActiveDialogShareQuery, GetActiveDialogShareQueryResult> {
  async handle(query: GetActiveDialogShareQuery): Promise<GetActiveDialogShareQueryResult> {
    const [row] = await getDb()
      .select()
      .from(dialogShares)
      .where(
        and(
          eq(dialogShares.userId, query.userId),
          eq(dialogShares.dialogId, query.dialogId),
          isNull(dialogShares.revokedAt),
          gt(dialogShares.expiresAt, query.now),
        ),
      )
      .limit(1)
    return { success: true, share: row ? toDialogShareDTO(row) : null }
  }
}
