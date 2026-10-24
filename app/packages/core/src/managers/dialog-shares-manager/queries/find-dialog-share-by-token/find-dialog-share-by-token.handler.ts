import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { dialogShares } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toDialogShareDTO } from '../../shared/dialog-share.dto'
import { FindDialogShareByTokenQuery } from './find-dialog-share-by-token.query'
import { type FindDialogShareByTokenQueryResult } from './find-dialog-share-by-token.types'


@requestHandler(FindDialogShareByTokenQuery)
export class FindDialogShareByTokenQueryHandler implements RequestHandler<FindDialogShareByTokenQuery, FindDialogShareByTokenQueryResult> {
  async handle(query: FindDialogShareByTokenQuery): Promise<FindDialogShareByTokenQueryResult> {
    const [row] = await getDb()
      .select()
      .from(dialogShares)
      .where(
        and(
          eq(dialogShares.tokenHash, query.tokenHash),
          isNull(dialogShares.revokedAt),
          gt(dialogShares.expiresAt, query.now),
        ),
      )
      .limit(1)
    return { success: true, share: row ? toDialogShareDTO(row) : null }
  }
}
