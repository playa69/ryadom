import { Button, Preloader } from 'framework7-react'
import type { ChangeEvent } from 'react'
import { RECAP_AGREEMENTS_HINT, RECAP_FIELD_LIMITS, RECAP_LABELS, type RecapFields } from '@ryadom/client-core/recaps'

/**
 * The three parts of a recap and «Предзаполнить» (add-mood-diary, D13): the model writes a draft, the person reads it,
 * edits it and saves. The same editor sits in the end sheet and in the journal entry.
 */
export default function RecapEditor({
  fields,
  onChange,
  onDraft,
  drafting,
  error,
}: {
  fields: RecapFields
  onChange: (next: RecapFields) => void
  onDraft?: () => void
  drafting: boolean
  error: string
}) {
  const edit = (key: keyof RecapFields) => (event: ChangeEvent<HTMLTextAreaElement>) =>
    onChange({ ...fields, [key]: event.target.value })
  return (
    <div className="rd-recap-editor" data-testid="recap-editor">
      {onDraft && (
        <Button small outline disabled={drafting} onClick={onDraft} data-testid="recap-draft" className="rd-recap-draft">
          {drafting ? <Preloader size={16} /> : 'Предзаполнить'}
        </Button>
      )}
      <label className="rd-recap-field">
        <span className="rd-caption">{RECAP_LABELS.about}</span>
        <textarea
          className="rd-takeaway rd-recap-area"
          data-testid="recap-about"
          maxLength={RECAP_FIELD_LIMITS.about}
          value={fields.about}
          onChange={edit('about')}
        />
      </label>
      <label className="rd-recap-field">
        <span className="rd-caption">{RECAP_LABELS.main}</span>
        <textarea
          className="rd-takeaway rd-recap-area"
          data-testid="recap-main"
          maxLength={RECAP_FIELD_LIMITS.main}
          value={fields.main}
          onChange={edit('main')}
        />
      </label>
      <label className="rd-recap-field">
        <span className="rd-caption">{RECAP_LABELS.agreements}</span>
        <textarea
          className="rd-takeaway rd-recap-area"
          data-testid="recap-agreements"
          value={fields.agreements}
          onChange={edit('agreements')}
        />
        <span className="rd-caption">{RECAP_AGREEMENTS_HINT}</span>
      </label>
      {error && (
        <p className="rd-form-error" data-testid="recap-error">
          {error}
        </p>
      )}
    </div>
  )
}
