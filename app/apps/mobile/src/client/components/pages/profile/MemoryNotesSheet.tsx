import { track } from '@ryadom/analytics/browser'
import { AnalyticsEvent } from '@ryadom/analytics/events'
import { Button, List, ListInput, Preloader, Sheet } from 'framework7-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  MEMORY_FACT_ERRORS,
  MEMORY_FORGET_ERRORS,
  MEMORY_INSTRUCTION_ERRORS,
  MEMORY_SHEET,
  MEMORY_SHEET_REFRESH_MS,
  groupNotes,
  instructionResultText,
  noteDateLabel,
  replaceNote,
} from '@ryadom/client-core/memory'
import { UpdateMemoryFactApiErrorCode, type MemoryApiResponse, type MemoryNoteApiResponse } from '@ryadom/contracts/api/memory'
import {
  apiErrorText,
  codeText,
  forgetMemoryFact,
  getMemory,
  memoryInstruction,
  updateMemoryFact,
} from '../../../lib/api'
import { pendingForgets, usePendingForgets } from '../../../lib/memory'

/** A rule of the server refused the corrected text: told neutrally, as with the field "Скажи, что поправить". */
const REFUSED = 'Так запомнить не получится'
const LOAD_FALLBACK = 'Не получилось загрузить память'

/**
 * The sheet "Что помнит Рядом": the notes in groups, each with its text and date. A tap corrects or
 * deletes a note, "×" deletes it with "Вернуть" for five seconds, and the field "Скажи, что поправить
 * или убрать" hands a request in words to the agent. Opened from the profile and from a conversation.
 *
 * The texts are the person's own words: the sheet carries `ph-no-capture`, nothing here is reported
 * but the kind of action, and nothing is stored on the device.
 */
export default function MemoryNotesSheet({
  opened,
  onClose,
  onChanged,
}: {
  opened: boolean
  onClose: () => void
  /** The notes or the switches may have changed: the caller reads its own state again. */
  onChanged?: () => void
}) {
  const [memory, setMemory] = useState<MemoryApiResponse | null>(null)
  const [loadError, setLoadError] = useState('')
  const [editing, setEditing] = useState<MemoryNoteApiResponse | null>(null)
  const [draft, setDraft] = useState('')
  const [editError, setEditError] = useState('')
  const [saving, setSaving] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState('')
  const [resultIsError, setResultIsError] = useState(false)
  const pending = usePendingForgets()
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    try {
      const next = await getMemory()
      if (mine !== generation.current) return
      setMemory(next)
      setLoadError('')
    } catch (error) {
      if (mine === generation.current) setLoadError(apiErrorText(error, {}, LOAD_FALLBACK))
    }
  }, [])

  // Each opening reads what is remembered now and starts from the list.
  useEffect(() => {
    if (!opened) return
    setEditing(null)
    setEditError('')
    setResult('')
    setInstruction('')
    void load()
  }, [opened, load])

  // Opened in a conversation, the list gets a new note without closing the sheet: it is read again every MEMORY_SHEET_REFRESH_MS.
  // Not while a note is being edited or a request is on its way, so the refresh does not overwrite what the person is doing.
  const busy = editing !== null || saving || sending
  useEffect(() => {
    if (!opened || busy) return
    const timer = setInterval(() => void load(), MEMORY_SHEET_REFRESH_MS)
    return () => clearInterval(timer)
  }, [opened, busy, load])

  function startEditing(note: MemoryNoteApiResponse) {
    setEditing(note)
    setDraft(note.text)
    setEditError('')
  }

  async function save() {
    if (!editing || saving) return
    const text = draft.trim()
    if (!text) {
      setEditError('Напиши, что запомнить, или удали заметку')
      return
    }
    setSaving(true)
    setEditError('')
    try {
      const outcome = await updateMemoryFact(editing.id, { text })
      if (!outcome.ok) {
        setEditError(
          outcome.code === UpdateMemoryFactApiErrorCode.FACT_REJECTED ? REFUSED : codeText(MEMORY_FACT_ERRORS, outcome.code, 'Не получилось сохранить'),
        )
        return
      }
      track(AnalyticsEvent.MemoryNoteEdited)
      setEditing(null)
      await load()
      onChanged?.()
    } catch (error) {
      setEditError(apiErrorText(error, {}, 'Не получилось сохранить'))
    } finally {
      setSaving(false)
    }
  }

  /** "×" and "Удалить": hidden at once, sent when the seconds for "Вернуть" are over. */
  function forget(note: MemoryNoteApiResponse) {
    setEditing(null)
    pendingForgets.schedule(note.id, async () => {
      try {
        const outcome = await forgetMemoryFact(note.id)
        if (!outcome.ok) {
          setResult(codeText(MEMORY_FORGET_ERRORS, outcome.code, 'Не получилось удалить'))
          setResultIsError(true)
          return
        }
        track(AnalyticsEvent.MemoryNoteDeleted, { undone: false })
        setMemory((current) => (current ? { ...current, notes: replaceNote(current.notes, note.id, null) } : current))
        onChanged?.()
      } catch (error) {
        setResult(apiErrorText(error, {}, 'Не получилось удалить'))
        setResultIsError(true)
      }
    })
  }

  async function send() {
    const text = instruction.trim()
    if (!text || sending) return
    setSending(true)
    setResult('')
    try {
      const outcome = await memoryInstruction(text)
      if (!outcome.ok) {
        setResult(codeText(MEMORY_INSTRUCTION_ERRORS, outcome.code, 'Не получилось'))
        setResultIsError(true)
        return
      }
      track(AnalyticsEvent.MemoryInstructionUsed)
      setResult(instructionResultText(outcome.data))
      setResultIsError(false)
      setInstruction('')
      await load()
      onChanged?.()
    } catch (error) {
      setResult(apiErrorText(error, {}, 'Не получилось'))
      setResultIsError(true)
    } finally {
      setSending(false)
    }
  }

  const notes = memory?.notes ?? []
  const view = groupNotes(notes)
  const visibleCount = notes.filter((note) => !pending.has(note.id)).length
  const paused = memory !== null && (memory.paused || !memory.enabled)

  return (
    <Sheet
      opened={opened}
      onSheetClosed={onClose}
      swipeToClose={!saving}
      closeOnEscape={!saving}
      backdrop
      style={{ height: 'auto' }}
    >
      <div className="rd-sheet-body rd-sheet-scroll ph-no-capture" data-testid="memory-notes">
        <h2 className="rd-sheet-title">{MEMORY_SHEET.title}</h2>

        {memory === null && !loadError && <Preloader />}
        {memory === null && loadError && (
          <>
            <p className="rd-form-error" data-testid="form-error">
              {loadError}
            </p>
            <Button outline onClick={() => void load()}>
              Попробовать ещё раз
            </Button>
          </>
        )}

        {memory !== null && editing && (
          <div data-testid="memory-note-edit">
            <List className="rd-form rd-memory-instruction">
              <ListInput
                label="Заметка"
                type="textarea"
                outline
                resizable
                maxlength={200}
                value={draft}
                info={`${draft.trim().length} из 200`}
                onChange={(event: { target: { value: string } }) => setDraft(event.target.value)}
              />
            </List>
            {editError && (
              <p className="rd-form-error" data-testid="form-error">
                {editError}
              </p>
            )}
            <Button
              fill
              large
              preloader
              loading={saving}
              disabled={saving}
              onClick={() => void save()}
              data-testid="memory-note-save"
            >
              Сохранить
            </Button>
            <Button large className="rd-danger" disabled={saving} onClick={() => forget(editing)} data-testid="memory-note-delete">
              Удалить
            </Button>
            <Button large disabled={saving} onClick={() => setEditing(null)}>
              Отмена
            </Button>
          </div>
        )}

        {memory !== null && !editing && (
          <>
            {paused && (
              <p className="rd-caption" data-testid="memory-paused">
                {MEMORY_SHEET.paused}
              </p>
            )}

            {visibleCount === 0 && (
              <p className="rd-muted" data-testid="memory-empty">
                {MEMORY_SHEET.empty}
              </p>
            )}

            {view.groups.map((group) => (
              <section key={group.id} data-testid="memory-group" data-group={group.id}>
                <h3 className="rd-note-group-title">{group.title}</h3>
                {group.notes.map((note) =>
                  pending.has(note.id) ? (
                    <div key={note.id} className="rd-memory-note rd-memory-undo" data-testid="memory-undo">
                      <span className="rd-caption">Удалено</span>
                      <Button small round onClick={() => {
                          if (pendingForgets.undo(note.id)) track(AnalyticsEvent.MemoryNoteDeleted, { undone: true })
                        }} data-testid="memory-undo-button">
                        {MEMORY_SHEET.undo}
                      </Button>
                    </div>
                  ) : (
                    <div
                      key={note.id}
                      className="rd-memory-note"
                      data-testid="memory-note"
                      data-kind={note.kind}
                    >
                      <button
                        type="button"
                        className="rd-memory-note-body"
                        onClick={() => startEditing(note)}
                        data-testid="memory-note-open"
                      >
                        <span className="rd-memory-note-text">{note.text}</span>
                        <span className="rd-memory-note-date">{noteDateLabel(note)}</span>
                      </button>
                      <button
                        type="button"
                        className="rd-memory-note-remove"
                        aria-label="Удалить заметку"
                        onClick={() => forget(note)}
                        data-testid="memory-note-remove"
                      >
                        ×
                      </button>
                    </div>
                  ),
                )}
              </section>
            ))}

            <List className="rd-form rd-memory-instruction">
              <ListInput
                label={MEMORY_SHEET.instructionLabel}
                type="text"
                outline
                maxlength={1000}
                placeholder={MEMORY_SHEET.instructionPlaceholder}
                value={instruction}
                disabled={sending || paused}
                onChange={(event: { target: { value: string } }) => setInstruction(event.target.value)}
                data-testid="memory-instruction"
              />
            </List>
            <Button
              fill
              large
              preloader
              loading={sending}
              disabled={sending || paused || !instruction.trim()}
              onClick={() => void send()}
              data-testid="memory-instruction-send"
            >
              {MEMORY_SHEET.instructionSend}
            </Button>
            {result && (
              <p
                className={resultIsError ? 'rd-form-error' : 'rd-caption rd-memory-result'}
                data-testid="memory-instruction-result"
              >
                {result}
              </p>
            )}
            <p className="rd-caption">{MEMORY_SHEET.deleteHint}</p>
            <Button large onClick={onClose} data-testid="memory-notes-close">
              Закрыть
            </Button>
          </>
        )}
      </div>
    </Sheet>
  )
}
