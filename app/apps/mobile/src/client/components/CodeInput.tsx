import { useEffect, useRef, type ChangeEvent } from 'react'
import { InputLimit } from '@ryadom/contracts/api/limits'

interface Props {
  value: string
  onChange: (value: string) => void
  /** Called once all six digits are in: the screen submits the code itself, with no button. */
  onComplete?: (value: string) => void
  disabled?: boolean
}

/**
 * Input for the code from the email. One field rather than six: the code arrives by email and is
 * pasted whole, and six separate fields break pasting on every platform.
 */
export default function CodeInput({ value, onChange, onComplete, disabled }: Props) {
  const input = useRef<HTMLInputElement>(null)
  const completed = useRef(false)

  useEffect(() => {
    input.current?.focus()
  }, [])

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const digits = event.target.value.replace(/\D/g, '').slice(0, InputLimit.CodeLength)
    onChange(digits)
    if (digits.length === InputLimit.CodeLength && !completed.current) {
      completed.current = true
      onComplete?.(digits)
    }
    if (digits.length < InputLimit.CodeLength) completed.current = false
  }

  return (
    <div className="rd-code">
      <input
        ref={input}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        aria-label="Код из письма"
        placeholder="······"
        maxLength={InputLimit.CodeLength}
        value={value}
        disabled={disabled}
        onChange={handleChange}
      />
    </div>
  )
}
