import { Button, Sheet } from 'framework7-react'
import { useEffect, useState, type ChangeEvent } from 'react'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { RECAP_AUTO_LABEL, RECAP_ERROR_TEXT } from '@ryadom/client-core/recaps'
import { UNSAVED_END_NOTE } from '@ryadom/client-core/unsaved'
import { Preloader } from 'framework7-react'
import { apiErrorText, draftDialogRecap, getDialogSettings, putDialogSettings } from '../../../lib/api'

/** Where the recap came from: written by the person, or pre-filled with «Предзаполнить» (and maybe edited). */
export type EndRecapSource = 'manual' | 'draft'

/**
 * Closing a conversation: the takeaway, which is also the recap of the conversation (add-mood-diary, D13), and the tension afterwards.
 *
 * Tension is not a survey for the sake of statistics: the product's headline metric is the
 * difference between before and after. So the scale is there, but it can be skipped.
 */
export default function DialogEndSheet({
  opened,
  dialogId,
  onClose,
  onSubmit,
  unsaved = false,
}: {
  opened: boolean
  dialogId: string
  onClose: () => void
  onSubmit: (takeaway: string | null, tensionAfter: number | null, recapSource: EndRecapSource) => void
  /** A conversation held unsaved keeps nothing, so nothing is asked: no takeaway, no scale, no recap. */
  unsaved?: boolean
}) {
  const [takeaway, setTakeaway] = useState('')
  const [tension, setTension] = useState<number | null>(null)
  // «Подводить итог автоматически»: read when the sheet opens; null until then.
  const [recapEnabled, setRecapEnabled] = useState<boolean | null>(null)
  const [drafted, setDrafted] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [recapError, setRecapError] = useState('')

  useEffect(() => {
    if (!opened || unsaved) return // nothing to set up for a conversation that keeps no recap
    getDialogSettings()
      .then((settings) => setRecapEnabled(settings.recapEnabled))
      .catch(() => setRecapEnabled(null))
  }, [opened, unsaved])

  async function changeEnabled(next: boolean) {
    setRecapEnabled(next)
    try {
      setRecapEnabled((await putDialogSettings(next)).recapEnabled)
    } catch {
      setRecapEnabled(!next)
    }
  }

  async function draft() {
    if (drafting) return
    setDrafting(true)
    setRecapError('')
    try {
      const result = await draftDialogRecap(dialogId)
      if (result.ok) {
        setTakeaway(result.data.recap.slice(0, InputLimit.TakeawayMax))
        setDrafted(true)
      } else setRecapError(RECAP_ERROR_TEXT[result.code])
    } catch (err) {
      setRecapError(apiErrorText(err, {}, RECAP_ERROR_TEXT.RECAP_UNAVAILABLE))
    } finally {
      setDrafting(false)
    }
  }

  function submit() {
    onSubmit(takeaway.trim() || null, tension, drafted ? 'draft' : 'manual')
  }

  if (unsaved) {
    return (
      <Sheet opened={opened} onSheetClosed={onClose} swipeToClose closeOnEscape backdrop style={{ height: 'auto' }}>
        <div className="rd-sheet-body rd-sheet-body--scroll">
          <h2 className="rd-sheet-title">Завершить разговор?</h2>
          <p className="rd-muted" data-testid="unsaved-end-note">
            {UNSAVED_END_NOTE}
          </p>
          <Button fill large onClick={() => onSubmit(null, null, 'manual')} data-testid="dialog-end-submit">
            Завершить
          </Button>
          <Button large onClick={onClose}>
            Продолжить разговор
          </Button>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet opened={opened} onSheetClosed={onClose} swipeToClose closeOnEscape backdrop style={{ height: 'auto' }}>
      <div className="rd-sheet-body rd-sheet-body--scroll">
        <h2 className="rd-sheet-title">Что забираешь с собой?</h2>
        <p className="rd-muted">Это и есть итог разговора, его увидишь только ты. Оставь пустым: подведу итог сам.</p>
        <textarea
          className="rd-takeaway"
          data-testid="takeaway-input"
          maxLength={InputLimit.TakeawayMax}
          value={takeaway}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setTakeaway(event.target.value)}
        />
        <Button small outline disabled={drafting} onClick={() => void draft()} data-testid="recap-draft" className="rd-recap-draft">
          {drafting ? <Preloader size={16} /> : 'Предзаполнить'}
        </Button>
        {recapError && (
          <p className="rd-form-error" data-testid="recap-error">
            {recapError}
          </p>
        )}

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

        <label className="rd-recap-auto" data-testid="recap-auto">
          <input
            type="checkbox"
            checked={recapEnabled === true}
            disabled={recapEnabled === null}
            onChange={(event) => void changeEnabled(event.target.checked)}
          />
          <span>{RECAP_AUTO_LABEL}</span>
        </label>

        <Button fill large onClick={submit} data-testid="dialog-end-submit">
          Завершить
        </Button>
        <Button large onClick={onClose}>
          Продолжить разговор
        </Button>
      </div>
    </Sheet>
  )
}
