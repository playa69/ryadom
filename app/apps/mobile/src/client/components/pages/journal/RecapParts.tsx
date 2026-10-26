import { Button, f7, Preloader, Sheet } from 'framework7-react'
import { useEffect, useState } from 'react'
import type { DialogApiResponse, DialogRecapApi, DialogSummaryApiResponse } from '@ryadom/contracts/api/dialogs'
import {
  DELETE_DIALOG_CONFIRM,
  EMPTY_RECAP_FIELDS,
  RECAP_CHECK_TEXT,
  RECAP_ERROR_TEXT,
  RECAP_LABELS,
  RECAP_PENDING_TEXT,
  UNSAVED_MARK_TEXT,
  fieldsFromRecap,
  recapFromFields,
  canWriteRecap,
} from '@ryadom/client-core/recaps'
import { apiErrorText, deleteDialog, draftDialogRecap, putDialogRecap } from '../../../lib/api'
import { openRoute } from '../../../lib/nav'
import { formatJournalDate } from './format'
import RecapEditor from './RecapEditor'

/** While the recap is being written the entry asks again this often. */
const PENDING_POLL_MS = 8_000

function RecapText({ recap }: { recap: DialogRecapApi }) {
  return (
    <dl className="rd-recap">
      <dt className="rd-caption">{RECAP_LABELS.about}</dt>
      <dd data-testid="journal-recap-about">{recap.about}</dd>
      <dt className="rd-caption">{RECAP_LABELS.main}</dt>
      <dd data-testid="journal-recap-main">{recap.main}</dd>
      {recap.agreements.length > 0 && (
        <>
          <dt className="rd-caption">{RECAP_LABELS.agreements}</dt>
          <dd>
            <ul className="rd-recap-list" data-testid="journal-recap-agreements">
              {recap.agreements.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </dd>
        </>
      )}
    </dl>
  )
}

/**
 * «Итог разговора» in the journal entry (add-mood-diary, D13): the three parts when it is ready, «Итог появится через минуту»
 * while it is being written, and «Написать итог» / «Предзаполнить» for a conversation without one (the automatic recap is off).
 */
export function RecapBlock({
  dialog,
  onSummary,
  onRefresh,
}: {
  dialog: DialogApiResponse
  onSummary: (summary: DialogSummaryApiResponse) => void
  onRefresh: () => void
}) {
  const summary = dialog.summary
  const status = summary?.recapStatus ?? 'none'
  const [writing, setWriting] = useState(false)
  const [fields, setFields] = useState(EMPTY_RECAP_FIELDS)
  const [drafted, setDrafted] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (status !== 'pending') return
    const timer = setInterval(() => {
      if (!document.hidden) onRefresh()
    }, PENDING_POLL_MS)
    return () => clearInterval(timer)
  }, [status, onRefresh])

  if (!dialog.endedAt || !summary) return null
  if (status === 'ready' && summary.recap) {
    return (
      <div className="rd-card" data-testid="journal-recap">
        <h3 className="rd-card-title">Итог разговора</h3>
        <RecapText recap={summary.recap} />
      </div>
    )
  }
  if (status === 'pending') {
    return (
      <div className="rd-card" data-testid="journal-recap-pending">
        <h3 className="rd-card-title">Итог разговора</h3>
        <p className="rd-muted">{RECAP_PENDING_TEXT}</p>
      </div>
    )
  }
  if (!canWriteRecap(summary, dialog.messages)) return null

  async function draft() {
    setDrafting(true)
    setError('')
    try {
      const result = await draftDialogRecap(dialog.dialogId)
      if (result.ok) {
        setFields(fieldsFromRecap(result.data.recap))
        setDrafted(true)
      } else setError(RECAP_ERROR_TEXT[result.code])
    } catch (err) {
      setError(apiErrorText(err, {}, RECAP_ERROR_TEXT.RECAP_UNAVAILABLE))
    } finally {
      setDrafting(false)
    }
  }

  async function save() {
    const checked = recapFromFields(fields)
    if (!checked.ok) return setError(RECAP_CHECK_TEXT[checked.reason])
    setSaving(true)
    setError('')
    try {
      const result = await putDialogRecap(dialog.dialogId, { ...checked.recap, source: drafted ? 'draft' : 'manual' })
      if (result.ok && result.data.summary) {
        onSummary(result.data.summary)
        setWriting(false)
      } else setError(result.ok ? RECAP_ERROR_TEXT.RECAP_UNAVAILABLE : RECAP_ERROR_TEXT[result.code])
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось сохранить итог'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rd-card" data-testid="journal-recap-none">
      <h3 className="rd-card-title">Итог разговора</h3>
      {!writing ? (
        <>
          <p className="rd-muted">Итога у этого разговора пока нет.</p>
          <div className="rd-recap-actions">
            <Button small outline onClick={() => setWriting(true)} data-testid="recap-write">
              Написать итог
            </Button>
            <Button
              small
              outline
              onClick={() => {
                setWriting(true)
                void draft()
              }}
              data-testid="recap-write-draft"
            >
              Предзаполнить
            </Button>
          </div>
        </>
      ) : (
        <>
          <RecapEditor fields={fields} onChange={setFields} onDraft={() => void draft()} drafting={drafting} error={error} />
          <div className="rd-recap-actions">
            <Button small fill disabled={saving} onClick={() => void save()} data-testid="recap-save">
              {saving ? <Preloader size={16} /> : 'Сохранить'}
            </Button>
            <Button
              small
              outline
              disabled={saving}
              onClick={() => {
                setWriting(false)
                setError('')
              }}
            >
              Отмена
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

function durationText(startedAt: string, endedAt: string | null): string | null {
  if (!endedAt) return null
  const minutes = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000)
  if (!Number.isFinite(minutes) || minutes < 1) return null
  return minutes < 60 ? `${minutes} мин` : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
}

/** A conversation the person asked not to keep: a mark without text (date, time, how long), which can be deleted. */
export function UnsavedMark({ dialog }: { dialog: Pick<DialogApiResponse, 'startedAt' | 'endedAt'> }) {
  const duration = durationText(dialog.startedAt, dialog.endedAt)
  return (
    <div className="rd-card" data-testid="journal-unsaved">
      <p>{UNSAVED_MARK_TEXT}</p>
      <p className="rd-caption">
        {formatJournalDate(dialog.startedAt)}
        {duration ? ` · ${duration}` : ''}
      </p>
    </div>
  )
}

/** «Удалить разговор» with the confirmation of the spec: the facts of memory stay, the week summary is rebuilt, backups live 30 days. */
export function DeleteDialogRow({ dialogId, label, onDeleted }: { dialogId: string; label: string; onDeleted: () => void }) {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function remove() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await deleteDialog(dialogId)
      // A conversation that is already gone is what the person wanted.
      if (result.ok || result.code === 'DIALOG_NOT_FOUND') {
        setOpened(false)
        onDeleted()
      } else setError('Не получилось удалить разговор. Попробуй позже')
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось удалить разговор. Попробуй позже'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        small
        className="rd-share-button rd-danger-button"
        onClick={() => {
          setError('')
          setOpened(true)
        }}
        data-testid="journal-delete"
      >
        {label}
      </Button>
      <Sheet opened={opened} onSheetClosed={() => setOpened(false)} swipeToClose closeOnEscape backdrop style={{ height: 'auto' }}>
        <div className="rd-sheet-body" data-testid="journal-delete-confirm">
          <h2 className="rd-sheet-title">{DELETE_DIALOG_CONFIRM.title}</h2>
          {DELETE_DIALOG_CONFIRM.lines.map((line) => (
            <p key={line} className="rd-muted">
              {line}
            </p>
          ))}
          <button
            type="button"
            className="rd-link-button"
            data-testid="journal-delete-memory"
            onClick={() => {
              setOpened(false)
              f7.sheet.close()
              openRoute('/profile/memory/')
            }}
          >
            {DELETE_DIALOG_CONFIRM.memoryLink}
          </button>
          {error && (
            <p className="rd-form-error" data-testid="form-error">
              {error}
            </p>
          )}
          <Button fill large disabled={busy} onClick={() => void remove()} data-testid="journal-delete-confirm-yes">
            {DELETE_DIALOG_CONFIRM.confirm}
          </Button>
          <Button large onClick={() => setOpened(false)}>
            {DELETE_DIALOG_CONFIRM.cancel}
          </Button>
        </div>
      </Sheet>
    </>
  )
}
