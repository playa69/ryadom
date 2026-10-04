import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid, validateInput } from '../../../../shared'
import { UpdateUserNameCommand } from './update-user-name.command'
import { UpdateUserNameCommandErrorCode, type UpdateUserNameCommandResult } from './update-user-name.types'
import { updateUserNameSchema } from './update-user-name.validator'

/**
 * The name is trimmed, and an empty name is a caller error. A deleted account gives
 * USER_NOT_FOUND: a name must never come back into an anonymized row.
 */
@requestHandler(UpdateUserNameCommand)
export class UpdateUserNameCommandHandler implements RequestHandler<UpdateUserNameCommand, UpdateUserNameCommandResult> {
  async handle(command: UpdateUserNameCommand): Promise<UpdateUserNameCommandResult> {
    const input = validateInput(updateUserNameSchema, { name: command.name })
    if (!isUuid(command.userId)) return { success: false, error: UpdateUserNameCommandErrorCode.USER_NOT_FOUND }
    const [row] = await getDb()
      .update(users)
      .set({ name: input.name, updatedAt: new Date() })
      .where(and(eq(users.id, command.userId), eq(users.isDeleted, false)))
      .returning({ id: users.id })
    if (!row) return { success: false, error: UpdateUserNameCommandErrorCode.USER_NOT_FOUND }
    return { success: true }
  }
}
