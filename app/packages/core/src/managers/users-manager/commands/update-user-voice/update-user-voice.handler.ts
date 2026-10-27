import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { and, eq } from 'drizzle-orm'
import { users } from '@ryadom/db/schema'
import { getDb, isUuid, validateInput } from '../../../../shared'
import { UpdateUserVoiceCommand } from './update-user-voice.command'
import { UpdateUserVoiceCommandErrorCode, type UpdateUserVoiceCommandResult } from './update-user-voice.types'
import { updateUserVoiceSchema } from './update-user-voice.validator'

@requestHandler(UpdateUserVoiceCommand)
export class UpdateUserVoiceCommandHandler implements RequestHandler<
  UpdateUserVoiceCommand,
  UpdateUserVoiceCommandResult
> {
  async handle(command: UpdateUserVoiceCommand): Promise<UpdateUserVoiceCommandResult> {
    const input = validateInput(updateUserVoiceSchema, { voice: command.voice, voiceName: command.voiceName })
    if (!isUuid(command.userId))
      return { success: false, error: UpdateUserVoiceCommandErrorCode.USER_NOT_FOUND }
    const [row] = await getDb()
      .update(users)
      .set({ agentVoice: input.voice, agentVoiceName: input.voiceName, updatedAt: new Date() })
      .where(and(eq(users.id, command.userId), eq(users.isDeleted, false)))
      .returning({ id: users.id })
    if (!row) return { success: false, error: UpdateUserVoiceCommandErrorCode.USER_NOT_FOUND }
    return { success: true }
  }
}
