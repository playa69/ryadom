export enum SetVoicePipelineCommandErrorCode {
  /** The pipeline is already this one (another admin got there first): nothing was written. */
  ALREADY_SET = 'ALREADY_SET',
}

export type SetVoicePipelineCommandResult =
  { success: true } | { success: false; error: SetVoicePipelineCommandErrorCode }
