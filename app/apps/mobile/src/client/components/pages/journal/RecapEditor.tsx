import { Button, Preloader } from 'framework7-react'
import type { ChangeEvent } from 'react'
import { RECAP_MAX } from '@ryadom/contracts/api/dialogs'

/**
 * The recap of a conversation in the journal (add-mood-diary, D13): one free-form text and «Предзаполнить»: the model
 * writes a draft, the person reads it, edits it and saves.
 */
export default function RecapEditor({
  text,
  onChange,
  onDraft,
  drafting,
  error,
}: {
  text: string
  onChange: (next: string) => void
  onDraft?: () => void
  drafting: boolean
  error: string
}) {
  return (
    <div className="rd-recap-editor" data-testid="recap-editor">
      {onDraft && (
        <Button small outline disabled={drafting} onClick={onDraft} data-testid="recap-draft" className="rd-recap-draft">
          {drafting ? <Preloader size={16} /> : 'Предзаполнить'}
        </Button>
      )}
      <textarea
        className="rd-takeaway rd-recap-area"
        aria-label="Итог разговора"
        data-testid="recap-text"
        maxLength={RECAP_MAX}
        value={text}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
      />
      {error && (
        <p className="rd-form-error" data-testid="recap-error">
          {error}
        </p>
      )}
    </div>
  )
}
