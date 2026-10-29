// 1. Handler imports
import './change-voice-pipeline/change-voice-pipeline.handler'

import type { RequestData } from 'mediatr-ts'
import { mediatr } from '../../shared'

// 2. Contract re-exports
export { ChangeVoicePipelineOperation } from './change-voice-pipeline/change-voice-pipeline.operation'
export type { ChangeVoicePipelineOperationData } from './change-voice-pipeline/change-voice-pipeline.operation'

// 3. Type re-exports
export type { ChangeVoicePipelineResult } from './change-voice-pipeline/change-voice-pipeline.types'
export type { VoicePipeline, VoiceSettingsDTO } from '../../managers/voice-settings-manager'

// 4. Union type
import type { ChangeVoicePipelineOperation } from './change-voice-pipeline/change-voice-pipeline.operation'

export type VoiceSettingsOperations = ChangeVoicePipelineOperation

// 5. Facade
export class VoiceSettingsProcess implements IVoiceSettingsProcess {
  async execute<T extends VoiceSettingsOperations>(
    request: T,
  ): Promise<T extends RequestData<infer R> ? R : never> {
    return (await (mediatr.send as (r: VoiceSettingsOperations) => Promise<unknown>)(
      request,
    )) as T extends RequestData<infer R> ? R : never
  }
}

export interface IVoiceSettingsProcess {
  execute<T extends VoiceSettingsOperations>(request: T): Promise<T extends RequestData<infer R> ? R : never>
}

export const voiceSettingsProcess: IVoiceSettingsProcess = new VoiceSettingsProcess()
