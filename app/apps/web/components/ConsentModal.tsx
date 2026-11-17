'use client'

import { X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import { DIALOG_KEEP_NOTE, GUEST_LIFE_CLAUSE } from '@ryadom/client-core/retention'
import { ConsentCheckbox } from '@/app/(auth)/_components/consent-group'
import { PRIMARY_BUTTON } from '@/app/(auth)/_components/parts'
import Modal from './Modal'
import { BUTTON } from './controls'

/**
 * The consent window over the first screen. A press that would start a conversation ("Поговорить", the
 * sphere, the keyboard) opens it instead of sending anything; "Продолжить" hands the waiting start back,
 * and closing it (the cross, Esc or the backdrop) sends nothing and keeps the intent for the next try.
 *
 * The start turns memory on, so the tick covers that too and says where it is turned off. The retention
 * terms sit here, under the button, because this is where the person decides and the first screen keeps
 * to its invitation.
 */
export default function ConsentModal({
  open,
  termsUrl,
  consentUrl,
  onContinue,
  onClose,
}: {
  open: boolean
  termsUrl: string
  consentUrl: string
  /** The required checkbox is ticked: the waiting start may run (account, consents, conversation). */
  onContinue(): void
  /** Cross, Esc or the backdrop: nothing is sent, the first screen keeps the intent. */
  onClose(): void
}) {
  return (
    <Modal open={open} onClose={onClose} title="Перед началом" className="tab:w-[min(92vw,480px)]">
      <ConsentModalContent
        termsUrl={termsUrl}
        consentUrl={consentUrl}
        onContinue={onContinue}
        onClose={onClose}
      />
    </Modal>
  )
}

/**
 * Exported for the markup tests: Modal portals its children, which renderToStaticMarkup cannot see.
 * Modal mounts the content only while open, so every opening starts with the checkbox unticked.
 * The cross comes last in the DOM so the opening focus lands on the checkbox, not on "close".
 */
export function ConsentModalContent({
  termsUrl,
  consentUrl,
  onContinue,
  onClose,
}: {
  termsUrl: string
  consentUrl: string
  onContinue(): void
  onClose(): void
}) {
  const [checked, setChecked] = useState(false)
  return (
    <div className="flex flex-col gap-4" data-testid="consent-modal">
      <p className="text-base leading-[1.55] text-dim">
        Один раз подтверди, что согласен(на), — и можно говорить.
      </p>
      <ConsentCheckbox
        checked={checked}
        onCheckedChange={setChecked}
        termsUrl={termsUrl}
        consentUrl={consentUrl}
        memory
      />
      <Button
        type="button"
        className={PRIMARY_BUTTON}
        disabled={!checked}
        onClick={onContinue}
        data-testid="consent-continue"
      >
        Продолжить
      </Button>
      <p className="text-xs leading-normal text-faint text-balance" data-testid="guest-note">
        {DIALOG_KEEP_NOTE} Без почты аккаунт {GUEST_LIFE_CLAUSE}.
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Закрыть"
        onClick={onClose}
        data-testid="consent-close"
        className={cn(BUTTON, 'absolute top-3 right-3')}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  )
}
