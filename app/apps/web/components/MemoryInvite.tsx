'use client'

import { useEffect, useState } from 'react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import {
  MEMORY_INVITE,
  MEMORY_SETTINGS_ERRORS,
  memoryInUse,
  shouldInviteToMemory,
} from '@ryadom/client-core/memory'
import type { MemoryApiResponse } from '@ryadom/contracts/api/memory'
import { useAuth, useClient } from '@/lib/auth'
import { WEB_MEMORY_INVITE_DISMISSED_KEY } from '@/lib/storage-keys'
import MemoryConsent from './MemoryConsent'
import Modal from './Modal'
import { ModalActions, ModalText, ProfileButton } from './ProfileParts'

/**
 * The sheet "Рядом теперь запоминает важное": shown once on home to a signed-in person who has never
 * decided about memory. Nothing is chosen for them: "Включить" opens the consent sheet (the same one the
 * profile uses, and the same call that records the consent), "Не сейчас" closes it for good in this browser.
 */
export default function MemoryInvite({
  memory,
  onMemory,
}: {
  /** What home has read; null until it arrives or when the request failed. */
  memory: MemoryApiResponse | null
  onMemory(next: MemoryApiResponse): void
}) {
  const client = useClient()
  const { updateUser } = useAuth()
  // Read after hydration; until then the sheet is not shown.
  const [dismissed, setDismissed] = useState(true)
  const [step, setStep] = useState<'invite' | 'consent'>('invite')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(WEB_MEMORY_INVITE_DISMISSED_KEY) === '1')
    } catch {
      setDismissed(false)
    }
  }, [])

  const open = shouldInviteToMemory(memory, dismissed)

  function dismiss() {
    try {
      window.localStorage.setItem(WEB_MEMORY_INVITE_DISMISSED_KEY, '1')
    } catch {
      // Storage is blocked: the sheet is closed for this visit only.
    }
    setDismissed(true)
  }

  async function accept() {
    if (busy || !memory) return
    setBusy(true)
    setError('')
    const fallback = 'Не получилось включить память'
    try {
      const result = await client.setMemoryEnabled(true)
      if (!result.ok) {
        setError(codeText(MEMORY_SETTINGS_ERRORS, result.code, fallback))
        return
      }
      const next = { ...memory, ...result.data, paused: !result.data.enabled }
      onMemory(next)
      updateUser({ memoryEnabled: memoryInUse(next) })
      track(AnalyticsEvent.MemoryEnabled, { enabled: result.data.enabled })
      track(AnalyticsEvent.MemorySettingChanged, { setting: 'memory', enabled: result.data.enabled })
      dismiss()
    } catch (err) {
      setError(apiErrorText(err, {}, fallback))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  if (step === 'consent') {
    return (
      <MemoryConsent
        open
        kind="consent"
        busy={busy}
        error={error}
        onAccept={() => void accept()}
        onClose={() => {
          if (!busy) dismiss()
        }}
      />
    )
  }
  return (
    <Modal open onClose={dismiss} title={MEMORY_INVITE.title} className="tab:w-[min(92vw,560px)]">
      <div className="flex flex-col gap-3" data-testid="memory-invite">
        {MEMORY_INVITE.paragraphs.map((text) => (
          <ModalText key={text} className="text-[0.9375rem]">
            {text}
          </ModalText>
        ))}
      </div>
      <ModalActions>
        <ProfileButton type="button" variant="outline" onClick={dismiss} data-testid="memory-invite-decline">
          {MEMORY_INVITE.decline}
        </ProfileButton>
        <ProfileButton
          type="button"
          onClick={() => {
            setError('')
            setStep('consent')
          }}
          data-testid="memory-invite-accept"
        >
          {MEMORY_INVITE.accept}
        </ProfileButton>
      </ModalActions>
    </Modal>
  )
}
