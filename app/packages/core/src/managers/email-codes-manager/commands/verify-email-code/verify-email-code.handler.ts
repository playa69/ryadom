import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { emailCodes } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { VerifyEmailCodeCommand } from './verify-email-code.command'
import { VerifyEmailCodeCommandErrorCode, type VerifyEmailCodeCommandResult } from './verify-email-code.types'

/** Consecutive wrong attempts after which the code is burned and retrying it is pointless. */
const MAX_ATTEMPTS = 5

/**
 * The code is compared by value instead of by a single conditional UPDATE on the hash: a wrong
 * code has to be rejected and also counted as an attempt, so the live row is read first by email
 * and purpose. It is then burned by a conditional UPDATE, so two concurrent submissions of the
 * correct code cannot both succeed.
 */
@requestHandler(VerifyEmailCodeCommand)
export class VerifyEmailCodeCommandHandler
  implements RequestHandler<VerifyEmailCodeCommand, VerifyEmailCodeCommandResult>
{
  async handle(command: VerifyEmailCodeCommand): Promise<VerifyEmailCodeCommandResult> {
    const db = getDb()
    const now = new Date()
    const [row] = await db
      .select()
      .from(emailCodes)
      .where(
        and(
          eq(emailCodes.email, command.email),
          eq(emailCodes.purpose, command.purpose),
          isNull(emailCodes.usedAt),
          gt(emailCodes.expiresAt, now),
        ),
      )
      .orderBy(desc(emailCodes.createdAt))
      .limit(1)
    if (!row) return { success: false, error: VerifyEmailCodeCommandErrorCode.CODE_NOT_FOUND }

    if (row.codeHash === command.codeHash) {
      const [used] = await db
        .update(emailCodes)
        .set({ usedAt: now })
        .where(and(eq(emailCodes.id, row.id), isNull(emailCodes.usedAt)))
        .returning({ id: emailCodes.id })
      if (!used) return { success: false, error: VerifyEmailCodeCommandErrorCode.CODE_NOT_FOUND }
      return { success: true }
    }

    const attempts = row.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      await db.update(emailCodes).set({ attempts, usedAt: now }).where(eq(emailCodes.id, row.id))
      return { success: false, error: VerifyEmailCodeCommandErrorCode.TOO_MANY_ATTEMPTS }
    }
    await db.update(emailCodes).set({ attempts }).where(eq(emailCodes.id, row.id))
    return { success: false, error: VerifyEmailCodeCommandErrorCode.CODE_MISMATCH }
  }
}
