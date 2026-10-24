'use client'

import { useState } from 'react'
import { DEFAULT_AGENT_VOICE, type AgentVoice } from '@ryadom/contracts/api/auth/me'
import { DEFAULT_VOICE_ID, FEMALE_VOICES, MALE_VOICES, findVoice } from '@ryadom/contracts/voices'
import { Check, Play, Square } from 'lucide-react'
import { playVoiceSample, stopVoiceSample } from '@ryadom/client-core/voice-sample'
import { cn } from '@ryadom/ui/lib/utils'
import { useAuth, useClient } from '@/lib/auth'
import { BASE_PATH } from '@/lib/base-path'
import Modal from './Modal'
import { Busy, ModalActions, ProfileButton } from './ProfileParts'
import ProfileRow from './ProfileRow'

type Tab = 'female' | 'male'
const TABS: { id: Tab; label: string }[] = [
  { id: 'female', label: 'Женские' },
  { id: 'male', label: 'Мужские' },
]

const genderOf = (id: string): AgentVoice => findVoice(id)?.gender ?? 'male'

/**
 * The voice the agent speaks with. The row shows the current voice; a tap opens a modal with all
 * voices grouped by gender. Each voice can be heard (▶) before it is chosen, and the choice is
 * applied by the button. The voice is saved on the account and reaches the agent when the next
 * conversation starts, so it follows the person to another device. One row of the settings list: the caller wraps it in a section.
 */
export default function ProfileVoice() {
  const client = useClient()
  const { user, updateUser } = useAuth()
  const gender: AgentVoice = user?.voice ?? DEFAULT_AGENT_VOICE
  // The concrete voice is on the account; until the person picks one, the gender's default is the voice that speaks.
  const savedId = user?.voiceName ?? DEFAULT_VOICE_ID[gender]
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(savedId)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<Tab>(genderOf(savedId))
  const [failed, setFailed] = useState(false)

  function show() {
    setDraft(savedId)
    setTab(genderOf(savedId))
    setFailed(false)
    setOpen(true)
  }

  function close() {
    stopVoiceSample()
    setOpen(false)
  }

  function toggle(id: string) {
    if (playingId === id) return stopVoiceSample()
    setPlayingId(id)
    playVoiceSample(id, () => setPlayingId((now) => (now === id ? null : now)), `${BASE_PATH}/`)
  }

  async function apply() {
    stopVoiceSample()
    setSaving(true)
    setFailed(false)
    try {
      const me = await client.updateProfile({ voiceName: draft })
      updateUser({ voice: me.voice, voiceName: me.voiceName })
      setOpen(false)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li data-testid="voice-choice">
      <ProfileRow
        icon="voice"
        label="Голос"
        value={findVoice(savedId)?.name}
        onClick={show}
        testId="voice-name"
      />
      <Modal open={open} onClose={close} title="Голос агента">
        <div
          role="tablist"
          aria-label="Пол голоса"
          className="flex gap-1 rounded-lg bg-white/5 p-1"
          data-testid="voice-tabs"
        >
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'h-9 flex-1 rounded-md text-sm font-medium text-dim focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
                tab === t.id && 'bg-brand-soft text-foreground shadow-sm',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div
          className="-mx-2 flex max-h-[min(55dvh,26rem)] flex-col gap-3 overflow-y-auto px-2"
          data-testid="voice-modal"
        >
          {[
            { label: 'Женские', list: FEMALE_VOICES },
            { label: 'Мужские', list: MALE_VOICES },
          ]
            .filter(({ label }) => (tab === 'female') === (label === 'Женские'))
            .map(({ label, list }) => (
              <div key={label} role="radiogroup" aria-label={label} className="flex flex-col gap-1">
                {list.map((v) => (
                  <div
                    key={v.id}
                    className={cn(
                      'flex items-center gap-1 rounded-lg border border-transparent pr-1',
                      draft === v.id && 'border-brand-400/50 bg-brand-soft',
                    )}
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={draft === v.id}
                      onClick={() => setDraft(v.id)}
                      className="flex h-11 flex-1 items-center justify-between rounded-lg px-3 text-left text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                    >
                      {v.name}
                      {draft === v.id && <Check className="size-4 text-brand-400" aria-hidden="true" />}
                    </button>
                    <button
                      type="button"
                      aria-label={`${playingId === v.id ? 'Остановить' : 'Прослушать'}: ${v.name}`}
                      onClick={() => toggle(v.id)}
                      className="grid size-9 place-items-center rounded-full text-dim hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
                    >
                      {playingId === v.id ? <Square className="size-4" /> : <Play className="size-4" />}
                    </button>
                  </div>
                ))}
              </div>
            ))}
        </div>
        {failed && (
          <p role="alert" className="text-[0.8125rem] leading-[1.45] text-danger" data-testid="voice-error">
            Не получилось сохранить голос. Попробуй ещё раз.
          </p>
        )}
        <ModalActions>
          <ProfileButton type="button" variant="outline" onClick={close}>
            Отмена
          </ProfileButton>
          <ProfileButton
            type="button"
            disabled={draft === savedId || saving}
            onClick={() => void apply()}
            data-testid="voice-apply"
          >
            <Busy on={saving} />
            Применить
          </ProfileButton>
        </ModalActions>
      </Modal>
    </li>
  )
}
