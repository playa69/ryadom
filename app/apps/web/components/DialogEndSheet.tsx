'use client'

import { useId, useState } from 'react'
import type { DialogRecapApi } from '@ryadom/contracts/api/dialogs'
import { InputLimit } from '@ryadom/contracts/api/limits'
import {
  EMPTY_RECAP_FIELDS,
  RECAP_AUTO_LABEL,
  RECAP_CHECK_TEXT,
  fieldsFromRecap,
  recapFieldsTouched,
  recapFromFields,
} from '@ryadom/client-core/recaps'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'
import { Button } from '@ryadom/ui/components/button'
import { FieldError } from '@ryadom/ui/components/field'
import { Textarea } from '@ryadom/ui/components/textarea'
import { cn } from '@ryadom/ui/lib/utils'
import Modal from './Modal'
import RecapEditor from './RecapEditor'
import { BUSY } from './busy'
import { BUTTON } from './controls'

/** The recap the person wrote or pre-filled in the sheet; null leaves it to the agent (it writes one in the background). */
export interface EndRecap {
  recap: DialogRecapApi
  source: 'manual' | 'draft'
}

/**
 * Closing a conversation: the takeaway, the tension afterwards and the recap (add-mood-diary, D13).
 *
 * Tension is not a survey for the sake of statistics: the product's headline metric is the
 * difference between before and after. So the scale is there, but it can be skipped.
 */
export interface DialogEndSheetProps {
  open: boolean
  onClose(): void
  onSubmit(takeaway: string | null, tensionAfter: number | null, recap: EndRecap | null): void
  /** «Подводить итог автоматически»: null until the setting is read; absent hides the row (an agent without recaps). */
  recapEnabled?: boolean | null
  onRecapEnabledChange?(next: boolean): void
  /** «Предзаполнить»: the draft, or the reason it could not be written. */
  onDraft?(): Promise<{ recap: DialogRecapApi } | { error: string }>
  /** The end request is in flight: one press is enough, and the sheet must not vanish under it. */
  busy: boolean
  error: string
}

const SCALE = Array.from({ length: 10 }, (_, index) => index + 1)

// A phone on its side: the two closing buttons share a row and the takeaway field shrinks, so the
// sheet (about 290px of the 304 a 320px-tall window leaves) shows the button that ends the
// conversation without scrolling.
const SHORT_BUTTON = '[@media(max-height:520px)]:h-11 [@media(max-height:520px)]:flex-1'

export default function DialogEndSheet({
  open,
  onClose,
  onSubmit,
  busy,
  error,
  recapEnabled = null,
  onRecapEnabledChange,
  onDraft,
}: DialogEndSheetProps) {
  // Held here, not in the modal body (which unmounts on close): going back to the conversation
  // must not throw away what the person had already written.
  const [takeaway, setTakeaway] = useState('')
  const [tension, setTension] = useState<number | null>(null)
  const scaleLabelId = useId()
  const [writing, setWriting] = useState(false)
  const [fields, setFields] = useState(EMPTY_RECAP_FIELDS)
  const [drafted, setDrafted] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [recapError, setRecapError] = useState('')

  async function draft() {
    if (!onDraft || drafting) return
    setDrafting(true)
    setRecapError('')
    const result = await onDraft()
    setDrafting(false)
    if ('error' in result) return setRecapError(result.error)
    setFields(fieldsFromRecap(result.recap))
    setDrafted(true)
  }

  function submit() {
    if (busy) return
    // An untouched form leaves the recap to the agent; a touched one must be complete.
    if (!writing || !recapFieldsTouched(fields)) return onSubmit(takeaway.trim() || null, tension, null)
    const checked = recapFromFields(fields)
    if (!checked.ok) return setRecapError(RECAP_CHECK_TEXT[checked.reason])
    setRecapError('')
    onSubmit(takeaway.trim() || null, tension, { recap: checked.recap, source: drafted ? 'draft' : 'manual' })
  }

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

        {onRecapEnabledChange && (
          <label className="flex cursor-pointer items-center gap-3 py-1" data-testid="recap-auto">
            <NativeCheckbox
              checked={recapEnabled === true}
              disabled={recapEnabled === null || busy}
              onChange={(event) => onRecapEnabledChange(event.target.checked)}
            />
            <span className="text-base leading-snug text-foreground">{RECAP_AUTO_LABEL}</span>
          </label>
        )}
        {onDraft && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              className="min-h-11 self-start rounded-md px-1 text-[0.9375rem] text-dim underline underline-offset-4 hover:text-foreground focus-visible:text-foreground"
              aria-expanded={writing}
              onClick={() => setWriting((value) => !value)}
              data-testid="recap-toggle"
            >
              {writing ? 'Не писать итог самому' : 'Написать итог самому'}
            </button>
            {writing && (
              <RecapEditor fields={fields} onChange={setFields} onDraft={() => void draft()} drafting={drafting} error={recapError} compact />
            )}
          </div>
        )}

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
          onClick={submit}
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
