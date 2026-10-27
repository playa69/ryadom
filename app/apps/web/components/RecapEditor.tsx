'use client'

import { Loader2, Sparkles } from 'lucide-react'
import { RECAP_MAX } from '@ryadom/contracts/api/dialogs'
import { Button } from '@ryadom/ui/components/button'
import { FieldError } from '@ryadom/ui/components/field'
import { Textarea } from '@ryadom/ui/components/textarea'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON } from './controls'

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
  onChange(next: string): void
  onDraft?: () => void
  drafting: boolean
  error: string
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="recap-editor">
      {onDraft && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(BUTTON, 'h-auto min-h-11 self-start px-4')}
          aria-busy={drafting}
          disabled={drafting}
          onClick={onDraft}
          data-testid="recap-draft"
        >
          {drafting ? <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Sparkles aria-hidden="true" />}
          Предзаполнить
        </Button>
      )}
      <Textarea
        className="field-sizing-fixed min-h-28 resize-y"
        aria-label="Итог разговора"
        maxLength={RECAP_MAX}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        data-testid="recap-text"
      />
      {error && (
        <FieldError className="leading-[1.4]" data-testid="recap-error">
          {error}
        </FieldError>
      )}
    </div>
  )
}
