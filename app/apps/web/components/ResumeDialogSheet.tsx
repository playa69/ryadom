'use client'

import { Button } from '@ryadom/ui/components/button'
import { FieldError } from '@ryadom/ui/components/field'
import { cn } from '@ryadom/ui/lib/utils'
import Modal from './Modal'
import { BUSY } from './busy'
import { BUTTON } from './controls'

/**
 * Pressing "start" found a conversation the person left unfinished (with something said in it). They
 * decide: go on with it, or end it and begin a new one. Closing the sheet changes nothing and keeps
 * whatever they typed on home.
 */
export interface ResumeDialogSheetProps {
  open: boolean
  /** Go on with the unfinished conversation. */
  onContinue(): void
  /** End it and begin a new one. */
  onStartNew(): void
  /** Backdrop, Esc or the close button: stay on home with nothing changed. */
  onClose(): void
  /** The request for a new conversation is in flight: one press is enough, and the sheet must not vanish under it. */
  busy: boolean
  error: string
  /** A line under the question, e.g. that "Без памяти" applies only to a new conversation. */
  note?: string
}

export default function ResumeDialogSheet({
  open,
  onContinue,
  onStartNew,
  onClose,
  busy,
  error,
  note,
}: ResumeDialogSheetProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Есть незавершённый разговор"
      dismissible={!busy}
      className="tab:w-[min(92vw,480px)]"
    >
      <p className="text-base leading-[1.55] text-dim" data-testid="resume-text">
        Продолжить его или завершить и начать новый?
      </p>
      {note && (
        <p className="text-sm leading-normal text-faint" data-testid="resume-note">
          {note}
        </p>
      )}

      {error && (
        <FieldError className="text-center leading-[1.4]" data-testid="form-error">
          {error}
        </FieldError>
      )}

      {/* The main action comes first, so it is also where the keyboard focus lands when the sheet opens. */}
      <div className="flex flex-col gap-3">
        <Button
          type="button"
          className={cn(BUTTON, 'w-full bg-clip-border focus-visible:border-transparent')}
          disabled={busy}
          onClick={onContinue}
          data-testid="resume-continue"
        >
          Продолжить
        </Button>
        <Button
          type="button"
          variant="outline"
          // Important: the outline variant's glass surface resets the border colour, and a control's edge must stay the 3:1 line.
          className={cn(BUTTON, BUSY, 'w-full border-input!')}
          aria-busy={busy}
          onClick={onStartNew}
          data-testid="resume-new"
        >
          Завершить и начать новый
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={cn(BUTTON, 'w-full')}
          disabled={busy}
          onClick={onClose}
          data-testid="resume-close"
        >
          Закрыть
        </Button>
      </div>
    </Modal>
  )
}
