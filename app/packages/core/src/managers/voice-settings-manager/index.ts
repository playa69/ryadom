// 1. Handler imports
import './commands/set-voice-pipeline/set-voice-pipeline.handler'
import './queries/get-voice-pipeline/get-voice-pipeline.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { SetVoicePipelineCommand } from './commands/set-voice-pipeline/set-voice-pipeline.command'
export type { SetVoicePipelineCommandData } from './commands/set-voice-pipeline/set-voice-pipeline.command'
export { GetVoicePipelineQuery } from './queries/get-voice-pipeline/get-voice-pipeline.query'
export type { GetVoicePipelineQueryData } from './queries/get-voice-pipeline/get-voice-pipeline.query'

// 3. Type re-exports
export type { SetVoicePipelineCommandResult } from './commands/set-voice-pipeline/set-voice-pipeline.types'
export { SetVoicePipelineCommandErrorCode } from './commands/set-voice-pipeline/set-voice-pipeline.types'
export type { GetVoicePipelineQueryResult } from './queries/get-voice-pipeline/get-voice-pipeline.types'
export type { VoiceSettingsDTO } from './shared/voice-settings.dto'
export { DEFAULT_VOICE_PIPELINE } from './shared/voice-settings.dto'
export { VOICE_PIPELINES, type VoicePipeline } from '@ryadom/db/schema'

// 4. Union type
import type { SetVoicePipelineCommand } from './commands/set-voice-pipeline/set-voice-pipeline.command'
import type { GetVoicePipelineQuery } from './queries/get-voice-pipeline/get-voice-pipeline.query'

export type VoiceSettingsManagerRequests = SetVoicePipelineCommand | GetVoicePipelineQuery

// 5. Facade
export class VoiceSettingsManager implements IVoiceSettingsManager {
  async execute<T extends VoiceSettingsManagerRequests>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: VoiceSettingsManagerRequests) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IVoiceSettingsManager {
  execute<T extends VoiceSettingsManagerRequests>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const voiceSettingsManager: IVoiceSettingsManager = new VoiceSettingsManager()
