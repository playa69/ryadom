'use server'

import { VOICE_PIPELINES, type VoicePipeline } from '@ryadom/core/managers/voice-settings-manager'
import { ChangeVoicePipelineOperation, voiceSettingsProcess } from '@ryadom/core/processes/voice-settings'
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/session'
import { PIPELINE_LABELS } from '../_lib/pipeline-labels'
import type { VoiceActionState } from './shared'

function isPipeline(value: string): value is VoicePipeline {
  return (VOICE_PIPELINES as readonly string[]).includes(value)
}

/**
 * Repeats requireAdmin: the layout guard protects rendering, not the endpoint a server action exposes. The core process
 * writes the pipeline and its audit entry together.
 */
export async function changeVoicePipeline(
  _prev: VoiceActionState,
  formData: FormData,
): Promise<VoiceActionState> {
  const session = await requireAdmin()
  const pipeline = String(formData.get('pipeline') ?? '')
  if (!isPipeline(pipeline)) return { ok: null, error: 'Выберите голосовой путь.' }

  const result = await voiceSettingsProcess.execute(
    new ChangeVoicePipelineOperation({ adminEmail: session.email, pipeline }),
  )

  revalidatePath('/voice')
  revalidatePath('/audit')
  return {
    ok: `Голосовой путь сохранён: «${PIPELINE_LABELS[result.settings.pipeline]}». Действует со следующего старта разговора.`,
    error: null,
  }
}
