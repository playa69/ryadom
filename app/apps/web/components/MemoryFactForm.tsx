'use client'

import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { apiErrorText, codeText } from '@ryadom/client-core/errors'
import {
  MEMORY_CATEGORY_LABEL,
  MEMORY_FACT_ERRORS,
  MEMORY_FORM_NOTE,
  MEMORY_TEXT_PLACEHOLDER,
  PERSON_NAME_MAX,
  PERSON_NOTE_MAX,
  PERSON_ROLES,
  PERSON_SLOT_LABELS,
  STYLE_ADDRESS_LABEL,
  STYLE_ADDRESS_MAX,
  STYLE_SLOTS,
  memoryEditKind,
  memoryFactBody,
  memoryFactDraft,
  memoryTextMax,
  type MemoryFactDraft,
  type StyleChoiceSlot,
} from '@ryadom/client-core/memory'
import { MemoryFactCategory, type MemoryFactApiResponse } from '@ryadom/contracts/api/memory'
import { Button } from '@ryadom/ui/components/button'
import { FieldError } from '@ryadom/ui/components/field'
import { Input } from '@ryadom/ui/components/input'
import { Label } from '@ryadom/ui/components/label'
import { Textarea } from '@ryadom/ui/components/textarea'
import { cn } from '@ryadom/ui/lib/utils'
import { useClient } from '@/lib/auth'
import { BUTTON } from './controls'
import { Busy, FIELD_FOCUS, ModalActions, ProfileButton } from './ProfileParts'

/**
 * Correcting a fact ("Исправить") or writing a new one ("Добавить"), inside the modal. "How to talk to
 * me" and a close person are fields the server builds the text from; the rest is a short text. A
 * corrected or written fact becomes the person's own and pinned: the agent will not change it.
 * Mounted per opening (the modal mounts its content only while open), so it starts from the fact as it is.
 */

/** A native select drawn like the shared Input (the UI kit has no select that works under the strict CSP). */
const SELECT = cn(
  'h-13 w-full min-w-0 cursor-pointer rounded-lg border border-input bg-glass px-4 text-base text-foreground shadow-card outline-hidden',
  FIELD_FOCUS,
)

function Row({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor} className="leading-normal">
        {label}
      </Label>
      {children}
    </div>
  )
}

export default function MemoryFactForm({
  fact,
  categories,
  onSaved,
  onCancel,
}: {
  /** The fact to correct; null writes a new one. */
  fact: MemoryFactApiResponse | null
  /** For a new fact: what it may be about. */
  categories: MemoryFactCategory[]
  onSaved(fact: MemoryFactApiResponse, created: boolean): void
  onCancel(): void
}) {
  const client = useClient()
  const id = useId()
  const [category, setCategory] = useState<MemoryFactCategory>(
    () =>
      fact?.category ??
      categories.find((item) => item !== MemoryFactCategory.Style) ??
      MemoryFactCategory.Works,
  )
  const [draft, setDraft] = useState<MemoryFactDraft>(() => memoryFactDraft(fact))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const kind = memoryEditKind(category)
  const errorId = `${id}-error`

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    const checked = memoryFactBody(category, draft)
    if ('problem' in checked) {
      setError(checked.problem)
      return
    }
    setError('')
    setSaving(true)
    try {
      const result = fact
        ? await client.updateMemoryFact(fact.id, checked.body)
        : await client.createMemoryFact({ category, ...checked.body })
      if (!result.ok) {
        setError(codeText(MEMORY_FACT_ERRORS, result.code, 'Не получилось сохранить'))
        setSaving(false)
        return
      }
      onSaved(result.data, fact === null)
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось сохранить'))
      setSaving(false)
    }
  }

  const setStyle = (slot: StyleChoiceSlot, value: string | undefined) =>
    setDraft((current) => ({ ...current, style: { ...current.style, [slot]: value } }))
  const setPerson = (field: 'role' | 'name' | 'note', value: string) =>
    setDraft((current) => ({ ...current, person: { ...current.person, [field]: value } }))
  // The person's own role from a conversation may be missing from the list offered: it stays a choice.
  const roles =
    draft.person.role && !PERSON_ROLES.includes(draft.person.role)
      ? [draft.person.role, ...PERSON_ROLES]
      : PERSON_ROLES
  const invalid = error ? true : undefined

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(event) => void handleSubmit(event)}
      data-testid="memory-fact-form"
    >
      {fact ? (
        <p className="-mt-1 text-sm text-faint">{MEMORY_CATEGORY_LABEL[fact.category] ?? ''}</p>
      ) : (
        <Row label="О чём" htmlFor={`${id}-category`}>
          <select
            id={`${id}-category`}
            className={SELECT}
            value={category}
            onChange={(event) => {
              setCategory(event.target.value as MemoryFactCategory)
              setError('')
            }}
          >
            {categories.map((item) => (
              <option key={item} value={item}>
                {MEMORY_CATEGORY_LABEL[item]}
              </option>
            ))}
          </select>
        </Row>
      )}

      {kind === 'text' && (
        <Row label="Что запомнить" htmlFor={`${id}-text`}>
          <Textarea
            id={`${id}-text`}
            name="text"
            className={cn(FIELD_FOCUS, 'min-h-20 resize-y')}
            placeholder={MEMORY_TEXT_PLACEHOLDER[category] ?? ''}
            maxLength={memoryTextMax(category)}
            value={draft.text}
            aria-invalid={invalid}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
          />
          <span className="text-right text-xs text-faint">
            {draft.text.trim().length} из {memoryTextMax(category)}
          </span>
        </Row>
      )}

      {kind === 'style' && (
        <>
          <Row label={STYLE_ADDRESS_LABEL} htmlFor={`${id}-address`}>
            <Input
              id={`${id}-address`}
              name="address"
              className={FIELD_FOCUS}
              placeholder="Имя, если хочется"
              maxLength={STYLE_ADDRESS_MAX}
              value={draft.style.address ?? ''}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  style: { ...current.style, address: event.target.value },
                }))
              }
            />
          </Row>
          {(Object.keys(STYLE_SLOTS) as StyleChoiceSlot[]).map((slot) => (
            <div
              key={slot}
              role="group"
              aria-label={STYLE_SLOTS[slot].label}
              className="flex flex-col gap-1.5"
            >
              <span className="text-sm leading-normal font-medium">{STYLE_SLOTS[slot].label}</span>
              <div className="flex flex-wrap gap-2">
                {[...STYLE_SLOTS[slot].options, { value: undefined, label: 'не важно' }].map((option) => (
                  <Button
                    key={option.label}
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-pressed={draft.style[slot] === option.value}
                    onClick={() => setStyle(slot, option.value)}
                    className={cn(
                      BUTTON,
                      'border-input! px-3.5 text-sm text-dim aria-pressed:border-brand-line! aria-pressed:bg-brand-soft aria-pressed:text-foreground',
                    )}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      {kind === 'person' && (
        <>
          <Row label={PERSON_SLOT_LABELS.role} htmlFor={`${id}-role`}>
            <select
              id={`${id}-role`}
              className={SELECT}
              value={draft.person.role ?? ''}
              aria-invalid={invalid}
              onChange={(event) => setPerson('role', event.target.value)}
            >
              <option value="">Выбери</option>
              {roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </Row>
          <Row label={PERSON_SLOT_LABELS.name} htmlFor={`${id}-name`}>
            <Input
              id={`${id}-name`}
              name="person-name"
              className={FIELD_FOCUS}
              placeholder="Необязательно"
              maxLength={PERSON_NAME_MAX}
              autoComplete="off"
              value={draft.person.name ?? ''}
              onChange={(event) => setPerson('name', event.target.value)}
            />
          </Row>
          <Row label={PERSON_SLOT_LABELS.note} htmlFor={`${id}-note`}>
            <Input
              id={`${id}-note`}
              name="person-note"
              className={FIELD_FOCUS}
              placeholder="Например: поддерживает"
              maxLength={PERSON_NOTE_MAX}
              autoComplete="off"
              value={draft.person.note ?? ''}
              onChange={(event) => setPerson('note', event.target.value)}
            />
          </Row>
        </>
      )}

      {error && (
        <FieldError id={errorId} className="text-center leading-[1.4]" data-testid="form-error">
          {error}
        </FieldError>
      )}
      <p className="text-[0.8125rem] leading-[1.45] text-faint">{MEMORY_FORM_NOTE}</p>
      <ModalActions>
        <ProfileButton type="button" variant="outline" disabled={saving} onClick={onCancel}>
          Отмена
        </ProfileButton>
        <ProfileButton type="submit" aria-busy={saving || undefined} data-testid="memory-fact-save">
          <Busy on={saving} />
          Сохранить
        </ProfileButton>
      </ModalActions>
    </form>
  )
}
