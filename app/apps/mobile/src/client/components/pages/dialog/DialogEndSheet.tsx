import { Button, Sheet } from 'framework7-react'
import { useState, type ChangeEvent } from 'react'
import { InputLimit } from '@ryadom/contracts/api/limits'

/**
 * Closing a conversation: the takeaway and the tension afterwards.
 *
 * Tension is not a survey for the sake of statistics: the product's headline metric is the
 * difference between before and after. So the scale is there, but it can be skipped.
 */
export default function DialogEndSheet({
  opened,
  onClose,
  onSubmit,
}: {
  opened: boolean
  onClose: () => void
  onSubmit: (takeaway: string | null, tensionAfter: number | null) => void
}) {
  const [takeaway, setTakeaway] = useState('')
  const [tension, setTension] = useState<number | null>(null)

  return (
    <Sheet opened={opened} onSheetClosed={onClose} swipeToClose closeOnEscape backdrop style={{ height: 'auto' }}>
      <div className="rd-sheet-body">
        <h2 className="rd-sheet-title">Что забираешь с собой?</h2>
        <p className="rd-muted">Одна фраза, если захочется. Её увидишь только ты.</p>
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

        <Button fill large onClick={() => onSubmit(takeaway.trim() || null, tension)}>
          Завершить
        </Button>
        <Button large onClick={onClose}>
          Продолжить разговор
        </Button>
      </div>
    </Sheet>
  )
}
