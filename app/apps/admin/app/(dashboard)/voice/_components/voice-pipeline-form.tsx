'use client'

import type { VoicePipeline } from '@ryadom/core/managers/voice-settings-manager'
import { startTransition, useActionState, useState } from 'react'
import { Notice } from '@/components/notice'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { PIPELINE_LABELS } from '../../_lib/pipeline-labels'
import { changeVoicePipeline } from '../actions'
import { INITIAL_VOICE_ACTION_STATE } from '../shared'

const OPTIONS: { value: VoicePipeline; description: string }[] = [
  {
    value: 'sber',
    description:
      'GigaASR → GigaChat → SaluteSpeech. Голос человека не уходит в Google. Звучит один женский голос, выбор голоса в профиле не действует. Если путь недоступен — запасной Gemini Live.',
  },
  {
    value: 'gemini',
    description:
      'Речь в речь в одной модели. Звучит голос, выбранный человеком в профиле. Если путь недоступен — запасной Сбер (один женский голос).',
  },
]

export function VoicePipelineForm({ current, changedLine }: { current: VoicePipeline; changedLine: string }) {
  const [state, action, pending] = useActionState(changeVoicePipeline, INITIAL_VOICE_ACTION_STATE)
  const [picked, setPicked] = useState<VoicePipeline>(current)

  // Submitted by hand rather than through `action`: React resets a form after its action, and the radios would jump back
  // to the pipeline rendered first while the saved one is marked «Сейчас».
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    startTransition(() => action(data))
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {state.error && <Notice tone="error">{state.error}</Notice>}
      {state.ok && <Notice tone="success">{state.ok}</Notice>}

      <div role="radiogroup" aria-label="Голосовой путь" className="grid gap-3">
        {OPTIONS.map(({ value, description }) => (
          <label
            key={value}
            className={cn(
              'flex cursor-pointer items-start gap-3 rounded-md border bg-white p-4',
              picked === value
                ? 'border-gray-900 ring-1 ring-gray-900'
                : 'border-gray-200 hover:border-gray-300',
            )}
          >
            <input
              type="radio"
              name="pipeline"
              value={value}
              checked={picked === value}
              onChange={() => setPicked(value)}
              className="mt-1 size-4 accent-gray-900"
            />
            <span>
              <span className="flex items-center gap-2 font-semibold text-gray-900">
                {PIPELINE_LABELS[value]}
                {current === value && <StatusBadge tone="success">Сейчас</StatusBadge>}
              </span>
              <span className="mt-1 block text-gray-600">{description}</span>
            </span>
          </label>
        ))}
      </div>

      <p className="text-gray-500">{changedLine}</p>
      <Button type="submit" disabled={pending || picked === current}>
        {pending ? 'Секунду…' : 'Сохранить'}
      </Button>
    </form>
  )
}
