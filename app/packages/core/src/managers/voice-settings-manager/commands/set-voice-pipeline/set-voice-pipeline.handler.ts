import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { ne } from 'drizzle-orm'
import { voiceSettings } from '@ryadom/db/schema'
import { getDb, validateInput } from '../../../../shared'
import { SetVoicePipelineCommand } from './set-voice-pipeline.command'
import { SetVoicePipelineCommandErrorCode, type SetVoicePipelineCommandResult } from './set-voice-pipeline.types'
import { setVoicePipelineSchema } from './set-voice-pipeline.validator'

/**
 * Upserts the single row. The update is conditional, so two admins saving the same pipeline at once change it (and get
 * it audited) once.
 */
@requestHandler(SetVoicePipelineCommand)
export class SetVoicePipelineCommandHandler implements RequestHandler<
  SetVoicePipelineCommand,
  SetVoicePipelineCommandResult
> {
  async handle(command: SetVoicePipelineCommand): Promise<SetVoicePipelineCommandResult> {
    const input = validateInput(setVoicePipelineSchema, { pipeline: command.pipeline })
    const changes = { pipeline: input.pipeline, updatedAt: new Date(), updatedBy: command.adminEmail.trim().toLowerCase() }
    const rows = await getDb()
      .insert(voiceSettings)
      .values({ id: 1, ...changes })
      .onConflictDoUpdate({ target: voiceSettings.id, set: changes, setWhere: ne(voiceSettings.pipeline, changes.pipeline) })
      .returning({ id: voiceSettings.id })
    if (rows.length === 0) return { success: false, error: SetVoicePipelineCommandErrorCode.ALREADY_SET }
    return { success: true }
  }
}
