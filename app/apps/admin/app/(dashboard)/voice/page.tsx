import { GetVoicePipelineQuery, voiceSettingsManager } from '@ryadom/core/managers/voice-settings-manager'
import type { Metadata } from 'next'
import { PageHeader } from '@/components/page-header'
import { requireAdmin } from '@/lib/session'
import { formatMoscow } from '../_lib/labels'
import { PIPELINE_LABELS } from '../_lib/pipeline-labels'
import { VoicePipelineForm } from './_components/voice-pipeline-form'

export const metadata: Metadata = { title: 'Голос — админка «Рядом»' }
export const dynamic = 'force-dynamic'

/**
 * The voice pipeline of new conversations, for everyone. Dialog starts read it each time, so a change needs no deploy;
 * an open conversation keeps the pipeline it started with.
 */
export default async function VoicePage() {
  await requireAdmin()
  const { settings } = await voiceSettingsManager.execute(new GetVoicePipelineQuery())
  const changedLine =
    settings.updatedAt && settings.updatedBy
      ? `Изменён ${formatMoscow(settings.updatedAt)} · ${settings.updatedBy}`
      : `Не меняли: действует путь по умолчанию — ${PIPELINE_LABELS[settings.pipeline]}.`

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Голос">
        Каким путём агент слушает и отвечает голосом. Действует для всех со следующего старта разговора, в том числе
        возобновлённого; открытые разговоры идут прежним путём.
      </PageHeader>
      <VoicePipelineForm current={settings.pipeline} changedLine={changedLine} />
    </div>
  )
}
