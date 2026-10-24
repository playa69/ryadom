import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, count, eq, gt, isNull, lte } from 'drizzle-orm'
import { dialogShares } from '@ryadom/db/schema'
import { getDb, isForeignKeyViolation, isUniqueViolation } from '../../../../shared'
import { CreateDialogShareCommand } from './create-dialog-share.command'
import { CreateDialogShareCommandErrorCode, type CreateDialogShareCommandResult } from './create-dialog-share.types'

/** Makes the link of a dialog, unless it has one already or the account is at its limit. */
@requestHandler(CreateDialogShareCommand)
export class CreateDialogShareCommandHandler implements RequestHandler<CreateDialogShareCommand, CreateDialogShareCommandResult> {
  async handle(command: CreateDialogShareCommand): Promise<CreateDialogShareCommandResult> {
    const db = getDb()
    // An expired link is retired first, or it would keep the unique "one active link per dialog" slot.
    await db
      .update(dialogShares)
      .set({ revokedAt: command.now })
      .where(
        and(
          eq(dialogShares.userId, command.userId),
          eq(dialogShares.dialogId, command.dialogId),
          isNull(dialogShares.revokedAt),
          lte(dialogShares.expiresAt, command.now),
        ),
      )
    const [counted] = await db
      .select({ active: count() })
      .from(dialogShares)
      .where(
        and(
          eq(dialogShares.userId, command.userId),
          isNull(dialogShares.revokedAt),
          gt(dialogShares.expiresAt, command.now),
        ),
      )
    if ((counted?.active ?? 0) >= command.maxActive) return { success: false, error: CreateDialogShareCommandErrorCode.LIMIT_REACHED }
    try {
      await db
        .insert(dialogShares)
        .values({
          id: command.id,
          userId: command.userId,
          dialogId: command.dialogId,
          tokenHash: command.tokenHash,
          upToMessageId: command.upToMessageId,
          expiresAt: command.expiresAt,
          createdAt: command.now,
        })
      return { success: true }
    } catch (error) {
      if (isUniqueViolation(error) || isForeignKeyViolation(error)) {
        return { success: false, error: CreateDialogShareCommandErrorCode.ALREADY_EXISTS }
      }
      throw error
    }
  }
}
