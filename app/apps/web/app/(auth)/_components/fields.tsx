'use client'

import {
  useEffect,
  useId,
  useRef,
  type ChangeEvent,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react'
import { InputLimit } from '@ryadom/contracts/api/limits'
import { Field, FieldDescription, FieldLabel } from '@ryadom/ui/components/field'
import { Input } from '@ryadom/ui/components/input'
import { Label } from '@ryadom/ui/components/label'
import { NativeCheckbox } from '@ryadom/ui/components/native-checkbox'
import { PasswordInput } from '@ryadom/ui/components/password-input'
import { cn } from '@ryadom/ui/lib/utils'
import { FIELD_FOCUS, FOCUS_RING } from './focus'

type NativeProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange' | 'className'>

interface FieldProps extends NativeProps {
  label: string
  value: string
  onChange(value: string): void
  hint?: string
  invalid?: boolean
  /** Focus on arrival, but only where a hardware keyboard is likely: a phone would throw the keyboard up. */
  focusOnFinePointer?: boolean
}

/** Field is role="group" by default, which would announce an unnamed group around every control. */
function PlainField(props: ComponentProps<typeof Field>) {
  return <Field role="none" {...props} />
}

// The Label default is tighter; the rest of the form's text runs at 1.5 and the form would shift up.
const LABEL = 'leading-normal'
const HINT = 'text-[0.8125rem] leading-normal text-faint'

export function TextField({
  label,
  value,
  onChange,
  hint,
  invalid,
  focusOnFinePointer,
  ...rest
}: FieldProps) {
  const id = useId()
  const hintId = `${id}-hint`
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (focusOnFinePointer && window.matchMedia('(pointer: fine)').matches) ref.current?.focus()
  }, [focusOnFinePointer])

  return (
    <PlainField>
      <FieldLabel htmlFor={id} className={LABEL}>
        {label}
      </FieldLabel>
      <Input
        {...rest}
        ref={ref}
        id={id}
        className={FIELD_FOCUS}
        value={value}
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && (
        <FieldDescription id={hintId} className={HINT}>
          {hint}
        </FieldDescription>
      )}
    </PlainField>
  )
}

/** Password field with a reveal button: on a phone a typo in a masked password is invisible. */
export function PasswordField({
  label,
  value,
  onChange,
  hint,
  invalid,
  autoComplete,
  ...rest
}: Omit<FieldProps, 'autoComplete' | 'type' | 'focusOnFinePointer'> & {
  autoComplete: 'current-password' | 'new-password'
}) {
  const id = useId()
  const hintId = `${id}-hint`

  return (
    <PlainField>
      <FieldLabel htmlFor={id} className={LABEL}>
        {label}
      </FieldLabel>
      <PasswordInput
        {...rest}
        id={id}
        className={FIELD_FOCUS}
        value={value}
        autoComplete={autoComplete}
        aria-invalid={invalid ? 'true' : undefined}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && (
        <FieldDescription id={hintId} className={HINT}>
          {hint}
        </FieldDescription>
      )}
    </PlainField>
  )
}

interface CodeFieldProps {
  value: string
  onChange(value: string): void
  /** Called once when the sixth digit arrives; the screen submits by itself, without a button. */
  onComplete?(value: string): void
  readOnly?: boolean
  invalid?: boolean
  autoFocus?: boolean
}

/**
 * The code from the email. One field rather than six: the code is pasted whole, and six separate
 * fields break pasting on every platform. There is no maxLength on purpose: the browser would cut
 * a pasted "123 456" at six characters, spaces included, and leave five digits. A plain Input, not
 * InputOTP: that one renders a style attribute on the server, which the page's CSP refuses.
 */
export function CodeField({ value, onChange, onComplete, readOnly, invalid, autoFocus }: CodeFieldProps) {
  const id = useId()
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const digits = event.target.value.replace(/\D/g, '').slice(0, InputLimit.CodeLength)
    onChange(digits)
    // Every change that arrives at a six-digit code that is not the one already in the field counts
    // as a new entry. A flag remembering "already submitted" would go stale: after a refused code
    // the next paste lands on a full field, and after a resend the screen empties the value itself.
    if (digits.length === InputLimit.CodeLength && digits !== value) onComplete?.(digits)
  }

  return (
    <PlainField>
      <FieldLabel htmlFor={id} className={LABEL}>
        Код из письма
      </FieldLabel>
      <Input
        ref={ref}
        id={id}
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="······"
        value={value}
        readOnly={readOnly}
        aria-invalid={invalid ? 'true' : undefined}
        onChange={handleChange}
        // Letter-spacing trails the last digit; the indent puts the digits back in the middle.
        className={cn(
          'px-0 text-center text-[length:clamp(26px,7vw,32px)] font-bold tracking-[0.3em] indent-[0.3em] tabular-nums',
          FIELD_FOCUS,
        )}
      />
    </PlainField>
  )
}

/**
 * The consent row: the whole box is the target. The checkbox is the native-input one, not Radix's:
 * that renders an inline style on the server, which the page's CSP refuses.
 */
export function ConsentField({
  checked,
  onChange,
  invalid,
  children,
}: {
  checked: boolean
  onChange(checked: boolean): void
  invalid?: boolean
  children: ReactNode
}) {
  return (
    <Label
      data-testid="consents"
      className={cn(
        'min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-input bg-surface px-4 py-3 text-[0.9375rem] leading-[1.45] font-normal text-muted-foreground select-text hover:border-muted-foreground',
        invalid && 'border-destructive',
      )}
    >
      <NativeCheckbox
        name="consent"
        checked={checked}
        required
        aria-invalid={invalid ? 'true' : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className={FOCUS_RING}
      />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </Label>
  )
}
