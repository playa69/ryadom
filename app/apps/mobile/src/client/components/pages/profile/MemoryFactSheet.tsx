import { Button, List, ListInput, Segmented, Sheet } from 'framework7-react'
import { useEffect, useState } from 'react'
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
import { apiErrorText, codeText, createMemoryFact, updateMemoryFact } from '../../../lib/api'

/**
 * Correcting a fact ("Исправить") or writing a new one ("Добавить"). "How to talk to me" and a close
 * person are fields the server builds the text from; the rest is a short text. A corrected or written
 * fact becomes the person's own and pinned: the agent will not change it.
 */
export default function MemoryFactSheet({
  opened,
  fact,
  categories,
  onSaved,
  onClose,
}: {
  opened: boolean
  /** The fact to correct; null writes a new one. */
  fact: MemoryFactApiResponse | null
  /** For a new fact: what it may be about. */
  categories: MemoryFactCategory[]
  onSaved: (fact: MemoryFactApiResponse, created: boolean) => void
  onClose: () => void
}) {
  const [category, setCategory] = useState<MemoryFactCategory>(fact?.category ?? MemoryFactCategory.Works)
  const [draft, setDraft] = useState<MemoryFactDraft>(() => memoryFactDraft(fact))
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Each opening starts from the fact as it is now (or from an empty form).
  useEffect(() => {
    if (!opened) return
    setCategory(
      fact?.category ??
        categories.find((item) => item !== MemoryFactCategory.Style) ??
        MemoryFactCategory.Works,
    )
    setDraft(memoryFactDraft(fact))
    setError('')
    setSaving(false)
    // `categories` is read once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, fact])

  const kind = memoryEditKind(category)

  async function save() {
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
        ? await updateMemoryFact(fact.id, checked.body)
        : await createMemoryFact({ category, ...checked.body })
      if (!result.ok) {
        setError(codeText(MEMORY_FACT_ERRORS, result.code, 'Не получилось сохранить'))
        return
      }
      onSaved(result.data, fact === null)
    } catch (err) {
      setError(apiErrorText(err, {}, 'Не получилось сохранить'))
    } finally {
      setSaving(false)
    }
  }

  const choose = (slot: StyleChoiceSlot, value: string | undefined) =>
    setDraft((current) => ({ ...current, style: { ...current.style, [slot]: value } }))

  // The person's own role from a conversation may be missing from the list offered: it stays a choice.
  const roles =
    draft.person.role && !PERSON_ROLES.includes(draft.person.role)
      ? [draft.person.role, ...PERSON_ROLES]
      : PERSON_ROLES

  return (
    <Sheet
      opened={opened}
      onSheetClosed={onClose}
      swipeToClose={!saving}
      closeOnEscape={!saving}
      backdrop
      style={{ height: 'auto' }}
    >
      <div className="rd-sheet-body rd-sheet-scroll" data-testid="memory-fact-form">
        <h2 className="rd-sheet-title">{fact ? 'Исправить' : 'Добавить в память'}</h2>
        {fact && <p className="rd-caption">{MEMORY_CATEGORY_LABEL[fact.category] ?? ''}</p>}

        <List className="rd-form rd-memory-form">
          {!fact && (
            <ListInput
              label="О чём"
              type="select"
              outline
              value={category}
              onChange={(event: { target: { value: string } }) => {
                setCategory(event.target.value as MemoryFactCategory)
                setError('')
              }}
            >
              {categories.map((item) => (
                <option key={item} value={item}>
                  {MEMORY_CATEGORY_LABEL[item]}
                </option>
              ))}
            </ListInput>
          )}

          {kind === 'text' && (
            <ListInput
              label="Что запомнить"
              type="textarea"
              outline
              resizable
              placeholder={MEMORY_TEXT_PLACEHOLDER[category] ?? ''}
              maxlength={memoryTextMax(category)}
              value={draft.text}
              info={`${draft.text.trim().length} из ${memoryTextMax(category)}`}
              onChange={(event: { target: { value: string } }) =>
                setDraft((current) => ({ ...current, text: event.target.value }))
              }
            />
          )}

          {kind === 'style' && (
            <ListInput
              label={STYLE_ADDRESS_LABEL}
              type="text"
              outline
              placeholder="Имя, если хочется"
              maxlength={STYLE_ADDRESS_MAX}
              value={draft.style.address ?? ''}
              onChange={(event: { target: { value: string } }) =>
                setDraft((current) => ({
                  ...current,
                  style: { ...current.style, address: event.target.value },
                }))
              }
            />
          )}

          {kind === 'person' && (
            <>
              <ListInput
                label={PERSON_SLOT_LABELS.role}
                type="select"
                outline
                value={draft.person.role ?? ''}
                onChange={(event: { target: { value: string } }) =>
                  setDraft((current) => ({
                    ...current,
                    person: { ...current.person, role: event.target.value },
                  }))
                }
              >
                <option value="">—</option>
                {roles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </ListInput>
              <ListInput
                label={PERSON_SLOT_LABELS.name}
                type="text"
                outline
                placeholder="Необязательно"
                maxlength={PERSON_NAME_MAX}
                value={draft.person.name ?? ''}
                onChange={(event: { target: { value: string } }) =>
                  setDraft((current) => ({
                    ...current,
                    person: { ...current.person, name: event.target.value },
                  }))
                }
              />
              <ListInput
                label={PERSON_SLOT_LABELS.note}
                type="text"
                outline
                placeholder="Например: поддерживает"
                maxlength={PERSON_NOTE_MAX}
                value={draft.person.note ?? ''}
                onChange={(event: { target: { value: string } }) =>
                  setDraft((current) => ({
                    ...current,
                    person: { ...current.person, note: event.target.value },
                  }))
                }
              />
            </>
          )}
        </List>

        {kind === 'style' &&
          (Object.keys(STYLE_SLOTS) as StyleChoiceSlot[]).map((slot) => (
            <div key={slot} className="rd-memory-choice">
              <p className="rd-caption">{STYLE_SLOTS[slot].label}</p>
              <Segmented strong tag="div">
                {STYLE_SLOTS[slot].options.map((option) => (
                  <Button
                    key={option.value}
                    active={draft.style[slot] === option.value}
                    onClick={() => choose(slot, option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
                <Button active={draft.style[slot] === undefined} onClick={() => choose(slot, undefined)}>
                  не важно
                </Button>
              </Segmented>
            </div>
          ))}

        {error && (
          <p className="rd-form-error" data-testid="form-error">
            {error}
          </p>
        )}
        <p className="rd-caption">{MEMORY_FORM_NOTE}</p>

        <Button
          fill
          large
          preloader
          loading={saving}
          disabled={saving}
          onClick={() => void save()}
          data-testid="memory-fact-save"
        >
          Сохранить
        </Button>
        <Button large disabled={saving} onClick={onClose}>
          Отмена
        </Button>
      </div>
    </Sheet>
  )
}
