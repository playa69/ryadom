import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { eq } from 'drizzle-orm'
import { userCredentials } from '@ryadom/db/schema'
import { getDb, isUuid } from '../../../../shared'
import { UpdateUserCredentialsCommand } from './update-user-credentials.command'
import {
  UpdateUserCredentialsCommandErrorCode,
  type UpdateUserCredentialsCommandResult,
} from './update-user-credentials.types'

@requestHandler(UpdateUserCredentialsCommand)
export class UpdateUserCredentialsCommandHandler implements RequestHandler<
  UpdateUserCredentialsCommand,
  UpdateUserCredentialsCommandResult
> {
  async handle(command: UpdateUserCredentialsCommand): Promise<UpdateUserCredentialsCommandResult> {
    if (!isUuid(command.userId)) {
      return { success: false, error: UpdateUserCredentialsCommandErrorCode.CREDENTIALS_NOT_FOUND }
    }
    const [row] = await getDb()
      .update(userCredentials)
      .set({ passwordHash: command.passwordHash, updatedAt: new Date() })
      .where(eq(userCredentials.userId, command.userId))
      .returning({ id: userCredentials.id })
    if (!row) return { success: false, error: UpdateUserCredentialsCommandErrorCode.CREDENTIALS_NOT_FOUND }
    return { success: true }
  }
}
