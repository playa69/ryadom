'use client'

import { Loader2, Sparkles } from 'lucide-react'
import { useId } from 'react'
import { RECAP_AGREEMENTS_HINT, RECAP_FIELD_LIMITS, RECAP_LABELS, type RecapFields } from '@ryadom/client-core/recaps'
import { Button } from '@ryadom/ui/components/button'
import { FieldError } from '@ryadom/ui/components/field'
import { Label } from '@ryadom/ui/components/label'
import { Textarea } from '@ryadom/ui/components/textarea'
import { cn } from '@ryadom/ui/lib/utils'
import { BUTTON } from './controls'

/**
 * The three parts of a recap (add-mood-diary, D13) and «Предзаполнить»: the model writes a draft, the person reads it,
 * edits it and saves. The same editor sits in the end sheet and in the journal entry.
 */
export default function RecapEditor({
  fields,
  onChange,
  onDraft,
  drafting,
  error,
  compact,
}: {
  fields: RecapFields
  onChange(next: RecapFields): void
  /** Asks the model for a draft; absent while the conversation is still going on (nothing to sum up yet). */
  onDraft?: () => void
  drafting: boolean
  error: string
  /** Shorter fields, for a sheet on a phone on its side. */
  compact?: boolean
}) {
  const id = useId()
  const area = cn('field-sizing-fixed resize-y', compact ? 'min-h-14' : 'min-h-16')
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-about`}>{RECAP_LABELS.about}</Label>
        <Textarea
          id={`${id}-about`}
          className={area}
          maxLength={RECAP_FIELD_LIMITS.about}
          value={fields.about}
          onChange={(event) => onChange({ ...fields, about: event.target.value })}
          data-testid="recap-about"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-main`}>{RECAP_LABELS.main}</Label>
        <Textarea
          id={`${id}-main`}
          className={area}
          maxLength={RECAP_FIELD_LIMITS.main}
          value={fields.main}
          onChange={(event) => onChange({ ...fields, main: event.target.value })}
          data-testid="recap-main"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-agreements`}>{RECAP_LABELS.agreements}</Label>
        <Textarea
          id={`${id}-agreements`}
          className={area}
          value={fields.agreements}
          aria-describedby={`${id}-agreements-hint`}
          onChange={(event) => onChange({ ...fields, agreements: event.target.value })}
          data-testid="recap-agreements"
        />
        <p id={`${id}-agreements-hint`} className="text-[0.8125rem] leading-snug text-faint">
          {RECAP_AGREEMENTS_HINT}
        </p>
      </div>
      {error && (
        <FieldError className="leading-[1.4]" data-testid="recap-error">
          {error}
        </FieldError>
      )}
    </div>
  )
}
