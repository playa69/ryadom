import { RequestData } from 'mediatr-ts'
import type { VoicePipeline } from '@ryadom/db/schema'
import { hasPII } from '../../../../shared'
import type { SetVoicePipelineCommandResult } from './set-voice-pipeline.types'

export interface SetVoicePipelineCommandData {
  pipeline: VoicePipeline
  /** The admin who picks it. */
  adminEmail: string
}

export class SetVoicePipelineCommand extends RequestData<SetVoicePipelineCommandResult> {
  /** Survives minification: SetVoicePipelineCommand.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'SetVoicePipelineCommand'

  public readonly pipeline: VoicePipeline

  @hasPII()
  public readonly adminEmail: string

  constructor(data: SetVoicePipelineCommandData) {
    super()
    this.pipeline = data.pipeline
    this.adminEmail = data.adminEmail
  }
}
