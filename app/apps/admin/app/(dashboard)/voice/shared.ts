/** Result of saving the voice pipeline; shown above the form. */
export interface VoiceActionState {
  ok: string | null
  error: string | null
}

export const INITIAL_VOICE_ACTION_STATE: VoiceActionState = { ok: null, error: null }
