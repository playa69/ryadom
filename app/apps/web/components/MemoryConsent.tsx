'use client'

import { MEMORY_CONSENT, MEMORY_HOW_IT_WORKS } from '@ryadom/client-core/memory'
import { FieldError } from '@ryadom/ui/components/field'
import Modal from './Modal'
import { Busy, ModalActions, ModalText, ProfileButton } from './ProfileParts'

/**
 * The consent sheet "Память", shown when the person turns memory on for the first time (or the text
 * has a new version). A separate document, not a clause of the terms: memory can be left off with
 * nothing else lost. The same sheet without the buttons of the answer is "Как это работает".
 * The text is a draft for the lawyer and the psychologist (see MEMORY_CONSENT).
 */
export default function MemoryConsent({
  open,
  kind,
  busy,
  error,
  onAccept,
  onClose,
}: {
  open: boolean
  /** `consent` asks for the answer; `info` only explains. */
  kind: 'consent' | 'info'
  busy: boolean
  error: string
  onAccept(): void
  /** Esc, the backdrop or "Не сейчас": memory stays as it was. */
  onClose(): void
}) {
  const consent = kind === 'consent'
  const paragraphs = consent ? MEMORY_CONSENT.paragraphs : MEMORY_HOW_IT_WORKS
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={consent ? MEMORY_CONSENT.title : 'Как это работает'}
      dismissible={!busy}
      className="max-h-[calc(100dvh-1rem)] overflow-y-auto tab:w-[min(92vw,560px)]"
    >
      <div className="flex flex-col gap-3" data-testid="memory-consent">
        {paragraphs.map((text) => (
          <ModalText key={text} className="text-[0.9375rem]">
            {text}
          </ModalText>
        ))}
        {consent && (
          <p className="text-[0.8125rem] leading-[1.45] text-faint">
            Версия текста от {MEMORY_CONSENT.version}
          </p>
        )}
      </div>
      {error && (
        <FieldError className="text-center leading-[1.4]" data-testid="form-error">
          {error}
        </FieldError>
      )}
      {consent ? (
        <ModalActions>
          <ProfileButton
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
            data-testid="memory-consent-decline"
          >
            {MEMORY_CONSENT.decline}
          </ProfileButton>
          <ProfileButton
            type="button"
            aria-busy={busy || undefined}
            onClick={onAccept}
            data-testid="memory-consent-accept"
          >
            <Busy on={busy} />
            {MEMORY_CONSENT.accept}
          </ProfileButton>
        </ModalActions>
      ) : (
        <ProfileButton type="button" className="w-full" onClick={onClose}>
          Понятно
        </ProfileButton>
      )}
    </Modal>
  )
}
