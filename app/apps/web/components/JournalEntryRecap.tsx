'use client'

import Link from 'next/link'
import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DialogApiResponse, DialogRecapApi, DialogSummaryApiResponse } from '@ryadom/contracts/api/dialogs'
import { apiErrorText } from '@ryadom/client-core/errors'
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
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { formatJournalDate } from '@/lib/journal'
import { BUSY } from './busy'
import { BUTTON } from './controls'
import Modal from './Modal'
import RecapEditor from './RecapEditor'

/** While the recap is being written the entry asks again this often. */
const PENDING_POLL_MS = 8_000

function RecapText({ recap }: { recap: DialogRecapApi }) {
  return (
    <dl className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <dt className="text-[0.8125rem] font-semibold text-faint">{RECAP_LABELS.about}</dt>
        <dd className="text-base leading-[1.55] wrap-anywhere text-foreground" data-testid="journal-recap-about">
          {recap.about}
        </dd>
      </div>
      <div className="flex flex-col gap-1">
        <dt className="text-[0.8125rem] font-semibold text-faint">{RECAP_LABELS.main}</dt>
        <dd className="text-base leading-[1.55] wrap-anywhere text-foreground" data-testid="journal-recap-main">
          {recap.main}
        </dd>
      </div>
      {recap.agreements.length > 0 && (
        <div className="flex flex-col gap-1">
          <dt className="text-[0.8125rem] font-semibold text-faint">{RECAP_LABELS.agreements}</dt>
          <dd>
            <ul className="list-disc pl-5 text-base leading-[1.55] text-foreground" data-testid="journal-recap-agreements">
              {recap.agreements.map((item) => (
                <li key={item} className="wrap-anywhere">
                  {item}
                </li>
              ))}
            </ul>
          </dd>
        </div>
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
  /** The summary came back changed (the person saved a recap). */
  onSummary(summary: DialogSummaryApiResponse): void
  /** Read the conversation again (the recap was pending). */
  onRefresh(): void
}) {
  const client = useClient()
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
      <Card className="gap-3 rounded-lg px-4 py-4 shadow-none tab:px-5" data-testid="journal-recap">
        <h2 className="text-lg font-semibold text-foreground">Итог разговора</h2>
        <RecapText recap={summary.recap} />
      </Card>
    )
  }
  if (status === 'pending') {
    return (
      <Card className="gap-2 rounded-lg px-4 py-4 shadow-none tab:px-5" data-testid="journal-recap-pending">
        <h2 className="text-lg font-semibold text-foreground">Итог разговора</h2>
        <p className="text-base leading-[1.55] text-dim">{RECAP_PENDING_TEXT}</p>
      </Card>
    )
  }
  // No recap: the person said too little, or the automatic recap is off. Offer to write one only where it can be.
  if (!canWriteRecap(summary, dialog.messages)) return null

  async function draft() {
    setDrafting(true)
    setError('')
    try {
      const result = await client.draftDialogRecap(dialog.dialogId)
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
      const result = await client.putDialogRecap(dialog.dialogId, { ...checked.recap, source: drafted ? 'draft' : 'manual' })
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
    <Card className="gap-3 rounded-lg px-4 py-4 shadow-none tab:px-5" data-testid="journal-recap-none">
      <h2 className="text-lg font-semibold text-foreground">Итог разговора</h2>
      {!writing ? (
        <>
          <p className="text-base leading-[1.55] text-dim">Итога у этого разговора пока нет.</p>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(BUTTON, 'h-auto min-h-11 px-4')}
              onClick={() => setWriting(true)}
              data-testid="recap-write"
            >
              Написать итог
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(BUTTON, 'h-auto min-h-11 px-4')}
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
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              className={cn(BUTTON, BUSY, 'min-h-11 bg-clip-border px-5 focus-visible:border-transparent')}
              aria-busy={saving}
              onClick={() => !saving && void save()}
              data-testid="recap-save"
            >
              Сохранить
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(BUTTON, 'h-auto min-h-11 px-4')}
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
    </Card>
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
    <Card className="gap-2 rounded-lg px-4 py-4 shadow-none tab:px-5" data-testid="journal-unsaved">
      <p className="text-base leading-[1.55] text-foreground">{UNSAVED_MARK_TEXT}</p>
      <p className="text-[0.8125rem] text-faint tabular-nums">
        {formatJournalDate(dialog.startedAt)}
        {duration ? ` · ${duration}` : ''}
      </p>
    </Card>
  )
}

/** «Удалить разговор» with the confirmation of the spec: the facts of memory stay, the week summary is rebuilt, backups live 30 days. */
export function DeleteDialogButton({ dialogId, label, onDeleted }: { dialogId: string; label: string; onDeleted(): void }) {
  const client = useClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function remove() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const result = await client.deleteDialog(dialogId)
      // A conversation that is already gone is what the person wanted.
      if (result.ok || result.code === 'DIALOG_NOT_FOUND') onDeleted()
      else setError('Не получилось удалить разговор. Попробуй позже')
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось удалить разговор. Попробуй позже'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(BUTTON, 'h-auto min-h-11 gap-2 px-3 text-dim hover:text-foreground')}
        onClick={() => {
          setError('')
          setOpen(true)
        }}
        data-testid="journal-delete"
      >
        <Trash2 aria-hidden="true" />
        {label}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={DELETE_DIALOG_CONFIRM.title} dismissible={!busy}>
        <div className="flex flex-col gap-3" data-testid="journal-delete-confirm">
          {DELETE_DIALOG_CONFIRM.lines.map((line) => (
            <p key={line} className="text-base leading-[1.55] text-dim">
              {line}
            </p>
          ))}
          <Link href="/profile/memory" className="text-[0.9375rem] text-foreground underline underline-offset-4" data-testid="journal-delete-memory">
            {DELETE_DIALOG_CONFIRM.memoryLink}
          </Link>
          {error && (
            <p className="text-[0.9375rem] leading-[1.4] text-danger" role="alert" data-testid="form-error">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 tab:flex-row">
          <Button
            type="button"
            className={cn(BUTTON, BUSY, 'w-full bg-clip-border focus-visible:border-transparent tab:w-auto tab:flex-1')}
            aria-busy={busy}
            onClick={() => void remove()}
            data-testid="journal-delete-confirm-yes"
          >
            {DELETE_DIALOG_CONFIRM.confirm}
          </Button>
          <Button
            type="button"
            variant="outline"
            className={cn(BUTTON, 'w-full border-input! tab:w-auto tab:flex-1')}
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            {DELETE_DIALOG_CONFIRM.cancel}
          </Button>
        </div>
      </Modal>
    </>
  )
}
