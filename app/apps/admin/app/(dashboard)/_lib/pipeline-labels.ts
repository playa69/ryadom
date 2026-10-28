import type { VoicePipeline } from '@ryadom/core/managers/voice-settings-manager'

/** Kept apart from labels.ts: the voice form is a client component and must not pull the core into the browser. */
export const PIPELINE_LABELS: Record<VoicePipeline, string> = {
  sber: 'Сбер',
  gemini: 'Gemini Live',
}
