import { Button, Sheet } from 'framework7-react'
import { useState, type ChangeEvent } from 'react'
import { recapOutcome, takesRecap, type RecapOutcome } from '@ryadom/client-core/dialog-recap'
import { InputLimit } from '@ryadom/contracts/api/limits'

/**
 * Closing a conversation: the takeaway and the tension afterwards.
 *
 * Tension is not a survey for the sake of statistics: the product's headline metric is the
 * difference between before and after. So the scale is there, but it can be skipped.
 *
 * The takeaway starts as the agent's recap (what the talk was about and where it got to) once it
 * arrives, for the person to keep, edit or erase; their own words are never overwritten.
 */
export default function DialogEndSheet({
  opened,
  onClose,
  onSubmit,
  recap,
  recapPending,
}: {
  opened: boolean
  onClose: () => void
  onSubmit: (takeaway: string | null, tensionAfter: number | null, recap: RecapOutcome) => void
  /** The agent's recap for the field; null while there is none (not asked yet, none to give, failed). */
  recap: string | null
  /** The recap is being written: the hint says so, the field stays editable. */
  recapPending: boolean
}) {
  const [takeaway, setTakeaway] = useState('')
  const [tension, setTension] = useState<number | null>(null)
  // The last recap received and the one put into the field. Adjusted while rendering rather than in
  // an effect, so the field never shows a frame without the recap that has already arrived.
  const [received, setReceived] = useState<string | null>(null)
  const [offered, setOffered] = useState<string | null>(null)
  if (recap !== null && recap !== received) {
    setReceived(recap)
    if (takesRecap(takeaway, offered)) {
      setTakeaway(recap)
      setOffered(recap)
    }
  }
  const hint =
    offered !== null && takeaway === offered
      ? 'Это итог разговора: о чём говорили и к чему пришли. Поправь или сотри, если не так. Его увидишь только ты.'
      : recapPending && takeaway.trim() === ''
        ? 'Подвожу итог разговора…'
        : 'Одна фраза, если захочется. Её увидишь только ты.'

  return (
    <Sheet opened={opened} onSheetClosed={onClose} swipeToClose closeOnEscape backdrop style={{ height: 'auto' }}>
      <div className="rd-sheet-body">
        <h2 className="rd-sheet-title">Что забираешь с собой?</h2>
        <p className="rd-muted" aria-live="polite" data-testid="takeaway-hint">
          {hint}
        </p>
        <textarea
          className="rd-takeaway"
          data-testid="takeaway-input"
          maxLength={InputLimit.TakeawayMax}
          value={takeaway}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setTakeaway(event.target.value)}
        />

        <p className="rd-caption">Насколько тяжело сейчас? 1 — легко, 10 — очень тяжело.</p>
        <div className="rd-scale">
          {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={tension === value}
              onClick={() => setTension(value)}
            >
              {value}
            </button>
          ))}
        </div>

        <Button
          fill
          large
          onClick={() => {
            const sent = takeaway.trim() || null
            onSubmit(sent, tension, recapOutcome(offered, sent))
          }}
        >
          Завершить
        </Button>
        <Button large onClick={onClose}>
          Продолжить разговор
        </Button>
      </div>
    </Sheet>
  )
}
