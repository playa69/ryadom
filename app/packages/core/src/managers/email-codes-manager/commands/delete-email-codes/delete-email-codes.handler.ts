import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { emailCodes } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { DeleteEmailCodesCommand } from './delete-email-codes.command'
import type { DeleteEmailCodesCommandResult } from './delete-email-codes.types'

@requestHandler(DeleteEmailCodesCommand)
export class DeleteEmailCodesCommandHandler
  implements RequestHandler<DeleteEmailCodesCommand, DeleteEmailCodesCommandResult>
{
  async handle(command: DeleteEmailCodesCommand): Promise<DeleteEmailCodesCommandResult> {
    await getDb().delete(emailCodes).where(eq(emailCodes.email, command.email))
    return { success: true }
  }
}
