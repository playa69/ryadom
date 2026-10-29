import type { VoiceSettingsDTO } from '../../../managers/voice-settings-manager'

/** `changed: false` — the pipeline already was this one: nothing was written and nothing audited. */
export type ChangeVoicePipelineResult = { success: true; changed: boolean; settings: VoiceSettingsDTO }
