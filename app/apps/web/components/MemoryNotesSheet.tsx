'use client'

import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import {
  MEMORY_FACT_ERRORS,
  MEMORY_FORGET_ERRORS,
  MEMORY_INSTRUCTION_ERRORS,
  MEMORY_SHEET,
  groupNotes,
  instructionResultText,
  noteDateLabel,
  replaceNote,
} from '@ryadom/client-core/memory'
import {
  UpdateMemoryFactApiErrorCode,
  type MemoryNoteApiResponse,
} from '@ryadom/contracts/api/memory'
import { Button } from '@ryadom/ui/components/button'
import { Card } from '@ryadom/ui/components/card'
import { Input } from '@ryadom/ui/components/input'
import { Textarea } from '@ryadom/ui/components/textarea'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { pendingForgets, usePendingForgets } from '@/lib/memory'
import { BUTTON } from './controls'
import Modal from './Modal'
import { useNotice } from './Notice'
import { SECTION_HEADING } from './Page'
import { Busy, FIELD_FOCUS } from './ProfileParts'

/**
 * The sheet "Что помнит Рядом": the notes in groups, each with its date; a tap on the text or "Править"
 * corrects it (Сохранить / Удалить), "×" deletes with five seconds for "Вернуть"; below, the field
 * "Скажи, что поправить или убрать". The notes are the person's own words: they are held in memory of
 * the page only, and nothing but the kind of action is reported.
 */

const ACTION = cn(BUTTON, 'h-9 border-input! px-3.5 text-sm')

/** The rule refused the text: told the same way as on the instruction field, without saying which rule. */
const REJECTED = 'Так запомнить не получится'

export default function MemoryNotesSheet({
  open,
  notes,
  paused,
  hidden,
  canReveal,
  revealed,
  onToggleReveal,
  onNotes,
  onClose,
}: {
  open: boolean
  notes: MemoryNoteApiResponse[]
  paused: boolean
  /** The texts are behind "Показать" (a shared computer). */
  hidden: boolean
  canReveal: boolean
  revealed: boolean
  onToggleReveal(): void
  onNotes(update: (current: MemoryNoteApiResponse[]) => MemoryNoteApiResponse[]): void
  onClose(): void
}) {
  const client = useClient()
  const notify = useNotice()
  const pending = usePendingForgets()
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null)

  const view = groupNotes(notes)

  function forget(note: MemoryNoteApiResponse) {
    setEditing(null)
    pendingForgets.schedule(note.id, async () => {
      try {
        const outcome = await client.forgetMemoryFact(note.id)
        if (!outcome.ok) {
          notify(codeText(MEMORY_FORGET_ERRORS, outcome.code, 'Не получилось забыть'), 'error')
          return
        }
        track(AnalyticsEvent.MemoryNoteDeleted, { undone: false })
        onNotes((current) => replaceNote(current, note.id, null))
      } catch (err) {
        notify(apiErrorText(err, {}, 'Не получилось забыть'), 'error')
      }
    })
  }

  function undo(note: MemoryNoteApiResponse) {
    if (pendingForgets.undo(note.id)) track(AnalyticsEvent.MemoryNoteDeleted, { undone: true })
  }

  async function save(note: MemoryNoteApiResponse) {
    if (!editing || saving) return
    const text = editing.text.trim()
    if (!text) {
      setEditError('Напиши, что запомнить')
      return
    }
    if (text === note.text) {
      setEditing(null)
      return
    }
    setSaving(true)
    setEditError('')
    try {
      const outcome = await client.updateMemoryFact(note.id, { text })
      if (!outcome.ok) {
        setEditError(
          outcome.code === UpdateMemoryFactApiErrorCode.FACT_REJECTED
            ? REJECTED
            : codeText(MEMORY_FACT_ERRORS, outcome.code, 'Не получилось сохранить'),
        )
        return
      }
      track(AnalyticsEvent.MemoryNoteEdited)
      onNotes((current) =>
        replaceNote(current, note.id, { ...note, text: outcome.data.text, updatedAt: outcome.data.updatedAt }),
      )
      setEditing(null)
    } catch (err) {
      setEditError(apiErrorText(err, {}, 'Не получилось сохранить'))
    } finally {
      setSaving(false)
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const text = instruction.trim()
    if (!text || sending) return
    setSending(true)
    setResult(null)
    try {
      const outcome = await client.memoryInstruction(text)
      if (!outcome.ok) {
        setResult({ text: codeText(MEMORY_INSTRUCTION_ERRORS, outcome.code, 'Не получилось'), error: true })
        return
      }
      const changes = outcome.data
      track(AnalyticsEvent.MemoryInstructionUsed)
      onNotes((current) => {
        const gone = new Set(changes.deleted)
        const updated = new Map(changes.updated.map((note) => [note.id, note]))
        const kept = current.filter((note) => !gone.has(note.id)).map((note) => updated.get(note.id) ?? note)
        const known = new Set(kept.map((note) => note.id))
        return [...changes.added.filter((note) => !known.has(note.id)), ...kept]
      })
      setResult({ text: instructionResultText(changes), error: false })
      setInstruction('')
    } catch (err) {
      setResult({ text: apiErrorText(err, {}, 'Не получилось'), error: true })
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={MEMORY_SHEET.title}
      className="max-h-[calc(100dvh-1rem)] overflow-y-auto tab:w-[min(92vw,600px)]"
    >
      <div className="flex flex-col gap-4" data-testid="memory-sheet">
        {paused && (
          <p className="rounded-lg bg-brand-soft px-4 py-3 text-[0.9375rem] leading-normal text-dim" data-testid="memory-sheet-paused">
            {MEMORY_SHEET.paused}
          </p>
        )}

        {canReveal && view.count > 0 && (
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={ACTION}
              aria-pressed={revealed}
              onClick={onToggleReveal}
              data-testid="memory-reveal"
            >
              {revealed ? 'Скрыть тексты' : 'Показать'}
            </Button>
          </div>
        )}

        {view.count === 0 && (
          <p className="py-4 text-center text-[0.9375rem] leading-normal text-dim" data-testid="memory-sheet-empty">
            {MEMORY_SHEET.empty}
          </p>
        )}

        {view.groups.map((group) => (
          <section
            key={group.id}
            className="flex flex-col gap-2"
            data-testid="memory-group"
            data-group={group.id}
            aria-labelledby={`memory-group-${group.id}`}
          >
            <h3 id={`memory-group-${group.id}`} className={SECTION_HEADING}>
              {group.title}
            </h3>
            <ul className="flex flex-col gap-2">
              {group.notes.map((note) =>
                pending.has(note.id) ? (
                  <li key={note.id}>
                    <Card
                      className="flex-row items-center justify-between gap-3 rounded-lg px-4 py-2.5 shadow-none"
                      data-testid="memory-undo"
                    >
                      <span className="text-[0.9375rem] text-dim">Убрал.</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className={cn(ACTION, 'border-0!')}
                        onClick={() => undo(note)}
                        data-testid="memory-undo-button"
                      >
                        {MEMORY_SHEET.undo}
                      </Button>
                    </Card>
                  </li>
                ) : (
                  <li key={note.id}>
                    <Card className="gap-2 rounded-lg px-4 py-3 shadow-none" data-testid="memory-note" data-kind={note.kind}>
                      {editing?.id === note.id ? (
                        <div className="flex flex-col gap-2">
                          <Textarea
                            value={editing.text}
                            maxLength={200}
                            rows={2}
                            aria-label="Текст заметки"
                            className={FIELD_FOCUS}
                            data-testid="memory-edit-input"
                            onChange={(event) => setEditing({ id: note.id, text: event.target.value })}
                          />
                          {editError && (
                            <p className="text-[0.875rem] leading-[1.4] text-danger" role="alert" data-testid="memory-edit-error">
                              {editError}
                            </p>
                          )}
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              className={ACTION}
                              disabled={saving}
                              onClick={() => void save(note)}
                              data-testid="memory-edit-save"
                            >
                              <Busy on={saving} />
                              Сохранить
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className={cn(ACTION, 'text-danger hover:bg-danger-soft hover:text-danger')}
                              disabled={saving}
                              onClick={() => forget(note)}
                              data-testid="memory-edit-delete"
                            >
                              Удалить
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className={cn(ACTION, 'border-0!')}
                              disabled={saving}
                              onClick={() => setEditing(null)}
                            >
                              Отмена
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2">
                          <div className="flex min-w-0 flex-1 flex-col gap-1">
                            <p
                              className={cn(
                                'text-base leading-[1.45] wrap-anywhere',
                                hidden ? 'text-faint italic' : 'text-foreground',
                              )}
                              data-testid="memory-note-text"
                            >
                              {hidden ? 'Текст скрыт' : note.text}
                            </p>
                            <p className="text-[0.8125rem] leading-[1.4] text-faint" data-testid="memory-note-date">
                              {noteDateLabel(note)}
                            </p>
                            <div>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className={cn(ACTION, 'h-8 px-2')}
                                disabled={hidden}
                                onClick={() => {
                                  setEditError('')
                                  setEditing({ id: note.id, text: note.text })
                                }}
                                data-testid="memory-note-edit"
                              >
                                Править
                              </Button>
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className={cn(BUTTON, 'size-9 shrink-0 text-faint hover:text-danger')}
                            aria-label="Убрать заметку"
                            onClick={() => forget(note)}
                            data-testid="memory-note-delete"
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </div>
                      )}
                    </Card>
                  </li>
                ),
              )}
            </ul>
          </section>
        ))}

        <form className="flex flex-col gap-2" onSubmit={(event) => void send(event)} data-testid="memory-instruction">
          <label htmlFor="memory-instruction-input" className={SECTION_HEADING}>
            {MEMORY_SHEET.instructionLabel}
          </label>
          <div className="flex gap-2">
            <Input
              id="memory-instruction-input"
              value={instruction}
              maxLength={500}
              disabled={paused}
              placeholder={MEMORY_SHEET.instructionPlaceholder}
              className={FIELD_FOCUS}
              data-testid="memory-instruction-input"
              onChange={(event) => setInstruction(event.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              className={cn(ACTION, 'h-10')}
              disabled={paused || sending || !instruction.trim()}
              data-testid="memory-instruction-send"
            >
              <Busy on={sending} />
              {MEMORY_SHEET.instructionSend}
            </Button>
          </div>
          {result && (
            <p
              className={cn('px-1 text-[0.875rem] leading-[1.4]', result.error ? 'text-danger' : 'text-dim')}
              role={result.error ? 'alert' : 'status'}
              data-testid="memory-instruction-result"
            >
              {result.text}
            </p>
          )}
        </form>

        <p className="px-1 text-[0.8125rem] leading-[1.45] text-faint">{MEMORY_SHEET.deleteHint}</p>
      </div>
    </Modal>
  )
}
