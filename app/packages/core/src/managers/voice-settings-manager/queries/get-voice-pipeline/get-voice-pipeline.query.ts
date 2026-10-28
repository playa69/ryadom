import { RequestData } from 'mediatr-ts'
import type { GetVoicePipelineQueryResult } from './get-voice-pipeline.types'

export type GetVoicePipelineQueryData = Record<string, never>

export class GetVoicePipelineQuery extends RequestData<GetVoicePipelineQueryResult> {
  /** Survives minification: GetVoicePipelineQuery.name is lost in prod. Used by LoggingBehavior. */
  static readonly requestName = 'GetVoicePipelineQuery'

  constructor(_data: GetVoicePipelineQueryData = {}) {
    super()
  }
}
