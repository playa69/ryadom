import { RequestData } from 'mediatr-ts'
import type { VoicePipeline } from '@ryadom/db/schema'
import { hasPII } from '../../../shared'
import type { ChangeVoicePipelineResult } from './change-voice-pipeline.types'

export interface ChangeVoicePipelineOperationData {
  adminEmail: string
  pipeline: VoicePipeline
}

export class ChangeVoicePipelineOperation extends RequestData<ChangeVoicePipelineResult> {
  /** Survives minification: ChangeVoicePipelineOperation.name is not preserved in production. Used by LoggingBehavior. */
  static readonly requestName = 'ChangeVoicePipelineOperation'

  @hasPII()
  public readonly adminEmail: string

  public readonly pipeline: VoicePipeline

  constructor(data: ChangeVoicePipelineOperationData) {
    super()
    this.adminEmail = data.adminEmail
    this.pipeline = data.pipeline
  }
}
