import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { userCredentials } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { StoreUserCredentialsCommand } from './store-user-credentials.command'
import {
  StoreUserCredentialsCommandErrorCode,
  type StoreUserCredentialsCommandResult,
} from './store-user-credentials.types'

@requestHandler(StoreUserCredentialsCommand)
export class StoreUserCredentialsCommandHandler implements RequestHandler<
  StoreUserCredentialsCommand,
  StoreUserCredentialsCommandResult
> {
  async handle(command: StoreUserCredentialsCommand): Promise<StoreUserCredentialsCommandResult> {
    const now = new Date()
    const [row] = await getDb()
      .insert(userCredentials)
      .values({
        id: command.credentialsId,
        userId: command.userId,
        passwordHash: command.passwordHash,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: userCredentials.userId })
      .returning({ id: userCredentials.id })
    if (!row) return { success: false, error: StoreUserCredentialsCommandErrorCode.CREDENTIALS_ALREADY_EXIST }
    return { success: true }
  }
}
