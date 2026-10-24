import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid, validateInput } from '../../../../shared'
import { UpdateUserTimezoneCommand } from './update-user-timezone.command'
import { UpdateUserTimezoneCommandErrorCode, type UpdateUserTimezoneCommandResult } from './update-user-timezone.types'
import { updateUserTimezoneSchema } from './update-user-timezone.validator'

@requestHandler(UpdateUserTimezoneCommand)
export class UpdateUserTimezoneCommandHandler implements RequestHandler<UpdateUserTimezoneCommand, UpdateUserTimezoneCommandResult> {
  async handle(command: UpdateUserTimezoneCommand): Promise<UpdateUserTimezoneCommandResult> {
    const input = validateInput(updateUserTimezoneSchema, { timezone: command.timezone })
    if (!isUuid(command.userId)) return { success: false, error: UpdateUserTimezoneCommandErrorCode.USER_NOT_FOUND }
    const [row] = await getDb()
      .update(users)
      .set({ timezone: input.timezone, updatedAt: new Date() })
      .where(and(eq(users.id, command.userId), eq(users.isDeleted, false)))
      .returning({ id: users.id })
    if (!row) return { success: false, error: UpdateUserTimezoneCommandErrorCode.USER_NOT_FOUND }
    return { success: true }
  }
}
