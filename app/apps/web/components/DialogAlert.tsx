'use client'

import { Button } from '@ryadom/ui/components/button'
import { cn } from '@ryadom/ui/lib/utils'
import Modal from './Modal'
import { BUTTON } from './controls'

/** An offer under the message: something that would help, with its own button next to the acknowledgement. */
export interface DialogAlertOffer {
  text: string
  action: string
  onAction(): void
}

/** A short message the person has to acknowledge: microphone trouble, the closing summary. */
export default function DialogAlert({
  open,
  title,
  text,
  offer,
  onClose,
}: {
  open: boolean
  title: string
  text: string
  offer?: DialogAlertOffer
  onClose(): void
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="text-base leading-[1.55] text-dim" data-testid="alert-text">
        {text}
      </p>
      {offer && (
        <p className="text-base leading-[1.55] text-dim" data-testid="alert-offer">
          {offer.text}
        </p>
      )}
      <div className="flex flex-col gap-3 tab:flex-row-reverse tab:justify-start">
        <Button
          type="button"
          // A lone acknowledgement: full width on a phone sheet, its own width on a desktop pane.
          className={cn(BUTTON, 'w-full bg-clip-border focus-visible:border-transparent tab:w-auto tab:min-w-36')}
          onClick={onClose}
          data-testid="alert-ok"
        >
          ОК
        </Button>
        {offer && (
          <Button
            type="button"
            variant="outline"
            // Important: the outline variant's glass surface resets the border colour, and a control's edge must stay the 3:1 line.
            className={cn(BUTTON, 'w-full border-input! tab:w-auto')}
            onClick={offer.onAction}
            data-testid="alert-offer-action"
          >
            {offer.action}
          </Button>
        )}
      </div>
    </Modal>
  )
}
