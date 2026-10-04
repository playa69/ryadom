import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { users } from '@ryadom/db/schema'
import { createLogger, getDb } from '../../../../shared'
import { CreateUserCommand } from './create-user.command'
import { CreateUserCommandErrorCode, type CreateUserCommandResult } from './create-user.types'

@requestHandler(CreateUserCommand)
export class CreateUserCommandHandler implements RequestHandler<CreateUserCommand, CreateUserCommandResult> {
  async handle(command: CreateUserCommand): Promise<CreateUserCommandResult> {
    const now = new Date()
    // ON CONFLICT DO NOTHING instead of catching 23505, so the surrounding transaction is not aborted.
    const [row] = await getDb()
      .insert(users)
      .values({
        id: command.userId,
        email: command.email === null ? null : command.email.trim().toLowerCase(),
        name: command.name,
        isEmailConfirmed: command.isEmailConfirmed,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id })
    if (!row) {
      createLogger('users-manager').info('CreateUser: email already taken')
      return { success: false, error: CreateUserCommandErrorCode.USER_ALREADY_EXISTS }
    }
    return { success: true }
  }
}
