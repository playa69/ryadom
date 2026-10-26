import { Button, Sheet } from 'framework7-react'
import { useEffect, useState, type ChangeEvent } from 'react'
import type { DialogRecapApi } from '@ryadom/contracts/api/dialogs'
import { InputLimit } from '@ryadom/contracts/api/limits'
import {
  EMPTY_RECAP_FIELDS,
  RECAP_AUTO_LABEL,
  RECAP_CHECK_TEXT,
  RECAP_ERROR_TEXT,
  fieldsFromRecap,
  recapFieldsTouched,
  recapFromFields,
} from '@ryadom/client-core/recaps'
import { apiErrorText, draftDialogRecap, getDialogSettings, putDialogSettings } from '../../../lib/api'
import RecapEditor from '../journal/RecapEditor'

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
export default function DialogEndSheet({
  opened,
  dialogId,
  onClose,
  onSubmit,
}: {
  opened: boolean
  dialogId: string
  onClose: () => void
  onSubmit: (takeaway: string | null, tensionAfter: number | null, recap: EndRecap | null) => void
}) {
  const [takeaway, setTakeaway] = useState('')
  const [tension, setTension] = useState<number | null>(null)
  // «Подводить итог автоматически»: read when the sheet opens; null until then.
  const [recapEnabled, setRecapEnabled] = useState<boolean | null>(null)
  const [writing, setWriting] = useState(false)
  const [fields, setFields] = useState(EMPTY_RECAP_FIELDS)
  const [drafted, setDrafted] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [recapError, setRecapError] = useState('')

  useEffect(() => {
    if (!opened) return
    getDialogSettings()
      .then((settings) => setRecapEnabled(settings.recapEnabled))
      .catch(() => setRecapEnabled(null))
  }, [opened])

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
        setFields(fieldsFromRecap(result.data.recap))
        setDrafted(true)
      } else setRecapError(RECAP_ERROR_TEXT[result.code])
    } catch (err) {
      setRecapError(apiErrorText(err, {}, RECAP_ERROR_TEXT.RECAP_UNAVAILABLE))
    } finally {
      setDrafting(false)
    }
  }

  function submit() {
    // An untouched form leaves the recap to the agent; a touched one must be complete.
    if (!writing || !recapFieldsTouched(fields)) return onSubmit(takeaway.trim() || null, tension, null)
    const checked = recapFromFields(fields)
    if (!checked.ok) return setRecapError(RECAP_CHECK_TEXT[checked.reason])
    setRecapError('')
    onSubmit(takeaway.trim() || null, tension, { recap: checked.recap, source: drafted ? 'draft' : 'manual' })
  }

  return (
    <Sheet opened={opened} onSheetClosed={onClose} swipeToClose closeOnEscape backdrop style={{ height: 'auto' }}>
      <div className="rd-sheet-body rd-sheet-body--scroll">
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

        <label className="rd-recap-auto" data-testid="recap-auto">
          <input
            type="checkbox"
            checked={recapEnabled === true}
            disabled={recapEnabled === null}
            onChange={(event) => void changeEnabled(event.target.checked)}
          />
          <span>{RECAP_AUTO_LABEL}</span>
        </label>
        <button
          type="button"
          className="rd-link-button"
          aria-expanded={writing}
          onClick={() => setWriting((value) => !value)}
          data-testid="recap-toggle"
        >
          {writing ? 'Не писать итог самому' : 'Написать итог самому'}
        </button>
        {writing && (
          <RecapEditor fields={fields} onChange={setFields} onDraft={() => void draft()} drafting={drafting} error={recapError} />
        )}

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
