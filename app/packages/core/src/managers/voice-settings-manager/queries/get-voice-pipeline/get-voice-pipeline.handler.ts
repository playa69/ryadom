import { requestHandler, type RequestHandler } from 'mediatr-ts'
import { voiceSettings } from '@ryadom/db/schema'
import { getDb } from '../../../../shared'
import { toVoiceSettingsDTO } from '../../shared/voice-settings.dto'
import { GetVoicePipelineQuery } from './get-voice-pipeline.query'
import type { GetVoicePipelineQueryResult } from './get-voice-pipeline.types'

@requestHandler(GetVoicePipelineQuery)
export class GetVoicePipelineQueryHandler implements RequestHandler<
  GetVoicePipelineQuery,
  GetVoicePipelineQueryResult
> {
  async handle(_query: GetVoicePipelineQuery): Promise<GetVoicePipelineQueryResult> {
    const [row] = await getDb().select().from(voiceSettings).limit(1)
    return { success: true, settings: toVoiceSettingsDTO(row) }
  }
}
