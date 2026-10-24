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
    // No target: the address and the Telegram id are both unique, and either one being taken is the same answer.
    const [row] = await getDb()
      .insert(users)
      .values({
        id: command.userId,
        email: command.email === null ? null : command.email.trim().toLowerCase(),
        name: command.name,
        telegramId: command.telegramId,
        isEmailConfirmed: command.isEmailConfirmed,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: users.id })
    if (!row) {
      createLogger('users-manager').info('CreateUser: email or Telegram id already taken')
      return { success: false, error: CreateUserCommandErrorCode.USER_ALREADY_EXISTS }
    }
    return { success: true }
  }
}
