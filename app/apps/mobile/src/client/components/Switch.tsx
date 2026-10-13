import { Toggle } from 'framework7-react'

/**
 * Framework7's Toggle driven by state. Its `checked` makes the input a controlled one with a no-op
 * `onChange`, so React puts the box back right after the tap, before the native `change` that
 * Framework7 reports from: the toggle never moves. Here the input is left to the browser
 * (`defaultChecked`) and remounted whenever the state changes, so the screen can still move it back
 * (a consent declined, a request refused).
 */
export default function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (on: boolean) => void
  /** Where Framework7's list item puts it (`after`); read by the list item, not here. */
  slot?: string
}) {
  return (
    <Toggle
      key={checked ? 'on' : 'off'}
      defaultChecked={checked}
      disabled={disabled}
      onToggleChange={(on: boolean) => onChange(on)}
    />
  )
}
