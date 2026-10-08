'use client'

import { useState } from 'react'
import { AGENT_VOICES, DEFAULT_AGENT_VOICE, type AgentVoice } from '@ryadom/contracts/api/auth/me'
import { useAuth, useClient } from '@/lib/auth'
import { Busy, ProfileButton } from './ProfileParts'

const LABELS: Record<AgentVoice, string> = { male: 'Мужской', female: 'Женский' }

/**
 * The voice the agent speaks with: two choices, a man's and a woman's. The choice is saved on the
 * account at once and reaches the agent when the next conversation starts, so it follows the person
 * to another device. One row of the settings list: the caller wraps it in a section.
 */
export default function ProfileVoice() {
  const client = useClient()
  const { user, updateUser } = useAuth()
  const current: AgentVoice = user?.voice ?? DEFAULT_AGENT_VOICE
  const [saving, setSaving] = useState<AgentVoice | null>(null)
  const [failed, setFailed] = useState(false)

  async function choose(voice: AgentVoice) {
    if (voice === current || saving) return
    setSaving(voice)
    setFailed(false)
    try {
      const me = await client.updateProfile({ voice })
      updateUser({ voice: me.voice })
    } catch {
      setFailed(true)
    } finally {
      setSaving(null)
    }
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid="voice-choice">
      <div role="group" aria-label="Голос агента" className="grid grid-cols-2 gap-2">
        {AGENT_VOICES.map((voice) => (
          <ProfileButton
            key={voice}
            type="button"
            size="sm"
            variant={voice === current ? 'default' : 'outline'}
            aria-pressed={voice === current}
            aria-busy={saving === voice}
            data-testid={`voice-${voice}`}
            onClick={() => void choose(voice)}
          >
            <Busy on={saving === voice} />
            {LABELS[voice]}
          </ProfileButton>
        ))}
      </div>
      {failed && (
        <p role="alert" className="text-[0.8125rem] leading-[1.45] text-danger" data-testid="voice-error">
          Не получилось сохранить голос. Попробуй ещё раз.
        </p>
      )}
    </li>
  )
}
