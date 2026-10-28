import type { VoicePipeline, VoiceSettingsRow } from '@ryadom/db/schema'

/** The pipeline new conversations take until an admin picks one: the owner chose Sber as the main one. */
export const DEFAULT_VOICE_PIPELINE: VoicePipeline = 'sber'

/** The voice pipeline of new conversations; who changed it and when are null while nobody has. */
export interface VoiceSettingsDTO {
  pipeline: VoicePipeline
  updatedAt: Date | null
  updatedBy: string | null
}

export function toVoiceSettingsDTO(row: VoiceSettingsRow | undefined): VoiceSettingsDTO {
  if (!row) return { pipeline: DEFAULT_VOICE_PIPELINE, updatedAt: null, updatedBy: null }
  return { pipeline: row.pipeline, updatedAt: row.updatedAt, updatedBy: row.updatedBy }
}
