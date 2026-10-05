import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { emailCodes } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { CreateEmailCodeCommand } from './create-email-code.command'
import type { CreateEmailCodeCommandResult } from './create-email-code.types'

/**
 * A pair of (email, purpose) has at most one live code: earlier codes for that purpose are
 * deleted and the new one takes their place. Asking for a code again is routine ("the email
 * never arrived"), and telling the person to wait for the previous one is worse than issuing a
 * new one.
 *
 * Codes for other purposes are left alone: an email confirmation code and an admin sign-in code
 * live independently even for the same address.
 */
@requestHandler(CreateEmailCodeCommand)
export class CreateEmailCodeCommandHandler
  implements RequestHandler<CreateEmailCodeCommand, CreateEmailCodeCommandResult>
{
  async handle(command: CreateEmailCodeCommand): Promise<CreateEmailCodeCommandResult> {
    const db = getDb()
    await db
      .delete(emailCodes)
      .where(and(eq(emailCodes.email, command.email), eq(emailCodes.purpose, command.purpose)))
    await db.insert(emailCodes).values({
      id: command.codeId,
      email: command.email,
      purpose: command.purpose,
      codeHash: command.codeHash,
      expiresAt: command.expiresAt,
      createdAt: new Date(),
    })
    return { success: true }
  }
}
