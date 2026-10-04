'use client'

import { useId, useState } from 'react'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { Button } from '@ryadom/ui/components/button'
import { FieldError } from '@ryadom/ui/components/field'
import { Textarea } from '@ryadom/ui/components/textarea'
import { cn } from '@ryadom/ui/lib/utils'
import Modal from './Modal'
import { BUSY } from './busy'
import { BUTTON } from './controls'

/**
 * Closing a conversation: the takeaway and the tension afterwards.
 *
 * Tension is not a survey for the sake of statistics: the product's headline metric is the
 * difference between before and after. So the scale is there, but it can be skipped.
 */
export interface DialogEndSheetProps {
  open: boolean
  onClose(): void
  onSubmit(takeaway: string | null, tensionAfter: number | null): void
  /** The end request is in flight: one press is enough, and the sheet must not vanish under it. */
  busy: boolean
  error: string
}

const SCALE = Array.from({ length: 10 }, (_, index) => index + 1)

// A phone on its side: the two closing buttons share a row and the takeaway field shrinks, so the
// sheet (about 290px of the 304 a 320px-tall window leaves) shows the button that ends the
// conversation without scrolling.
const SHORT_BUTTON = '[@media(max-height:520px)]:h-11 [@media(max-height:520px)]:flex-1'

export default function DialogEndSheet({ open, onClose, onSubmit, busy, error }: DialogEndSheetProps) {
  // Held here, not in the modal body (which unmounts on close): going back to the conversation
  // must not throw away what the person had already written.
  const [takeaway, setTakeaway] = useState('')
  const [tension, setTension] = useState<number | null>(null)
  const scaleLabelId = useId()

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Что забираешь с собой?"
      dismissible={!busy}
      className="tab:w-[min(92vw,600px)]"
    >
      <div className="flex flex-col gap-3 [@media(max-height:520px)]:gap-2">
        <p className="text-base leading-[1.55] text-dim">Одна фраза, если захочется. Её увидишь только ты.</p>
        <Textarea
          // A box of its own height, as before: it stays resizable and does not grow with the text.
          className="field-sizing-fixed resize-y [@media(max-height:520px)]:min-h-14"
          name="takeaway"
          aria-label="Что забираешь с собой"
          data-testid="takeaway-input"
          maxLength={InputLimit.TakeawayMax}
          value={takeaway}
          onChange={(event) => setTakeaway(event.target.value)}
        />

        <p id={scaleLabelId} className="text-sm leading-snug text-faint">
          Насколько тяжело сейчас? 1 — легко, 10 — очень тяжело.
        </p>
        {/* Ten 44px targets do not fit a phone's sheet in one row: two rows of five, one row from 560px. */}
        <div
          className="grid grid-cols-5 gap-1.5 min-[560px]:grid-cols-10"
          role="group"
          aria-labelledby={scaleLabelId}
        >
          {SCALE.map((value) => {
            const pressed = tension === value
            return (
              <Button
                key={value}
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={pressed}
                onClick={() => setTension((current) => (current === value ? null : value))}
                data-testid="tension-option"
                // The shared Button clips its fill to the padding box; a lit or opaque fill has to reach the outer edge.
                className={cn(
                  BUTTON,
                  'w-full rounded-[14px] border-input bg-surface-2 bg-clip-border px-0 text-base font-normal text-dim hover:bg-surface-2 hover:text-foreground focus-visible:border-input',
                  pressed &&
                    'border-transparent bg-[image:var(--ryadom-cta)] font-bold text-cta-ink hover:text-cta-ink focus-visible:border-transparent',
                )}
              >
                {value}
              </Button>
            )
          })}
        </div>

        {error && (
          <FieldError className="text-center leading-[1.4]" data-testid="form-error">
            {error}
          </FieldError>
        )}
      </div>

      {/* Two buttons side by side on a desktop pane: stacked, each would stretch across the whole pane. */}
      <div className="flex flex-col gap-3 tab:flex-row [@media(max-height:520px)]:flex-row [@media(max-height:520px)]:gap-2">
        <Button
          type="button"
          className={cn(BUTTON, BUSY, 'w-full bg-clip-border focus-visible:border-transparent tab:w-auto tab:flex-1', SHORT_BUTTON)}
          aria-busy={busy}
          onClick={() => {
            if (!busy) onSubmit(takeaway.trim() || null, tension)
          }}
          data-testid="dialog-end-submit"
        >
          Завершить
        </Button>
        <Button
          type="button"
          variant="outline"
          // Important: the outline variant's glass surface resets the border colour, and a control's edge must stay the 3:1 line.
          className={cn(BUTTON, 'w-full border-input! tab:w-auto tab:flex-1', SHORT_BUTTON)}
          disabled={busy}
          onClick={onClose}
        >
          Продолжить разговор
        </Button>
      </div>
    </Modal>
  )
}
