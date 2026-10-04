'use client'

import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import Modal from './Modal'
import { BUTTON } from './controls'

/** A short message the person has to acknowledge: microphone trouble, the closing summary. */
export default function DialogAlert({
  open,
  title,
  text,
  onClose,
}: {
  open: boolean
  title: string
  text: string
  onClose(): void
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-base leading-[1.55] text-dim" data-testid="alert-text">
        {text}
      </p>
      <Button
        type="button"
        // A lone acknowledgement: full width on a phone sheet, its own width on a desktop pane.
        className={cn(BUTTON, 'w-full bg-clip-border focus-visible:border-transparent tab:w-auto tab:min-w-36 tab:justify-self-end')}
        onClick={onClose}
        data-testid="alert-ok"
      >
        ОК
      </Button>
    </Modal>
  )
}
