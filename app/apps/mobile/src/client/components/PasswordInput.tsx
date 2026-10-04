import { Icon, ListInput } from 'framework7-react'
import { useState, type ChangeEvent } from 'react'

interface Props {
  label: string
  /** Field name: password managers use it to decide what to offer. */
  name: string
  value: string
  onChange: (value: string) => void
  autocomplete: 'current-password' | 'new-password'
  info?: string
}

/** Password field with a reveal button: on a phone a typo in a masked password is invisible. */
export default function PasswordInput({ label, name, value, onChange, autocomplete, info }: Props) {
  const [visible, setVisible] = useState(false)
  return (
    <ListInput
      label={label}
      name={name}
      type={visible ? 'text' : 'password'}
      value={value}
      info={info}
      outline
      floatingLabel
      autocomplete={autocomplete}
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      className="rd-password"
      onInput={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
    >
      <button
        slot="content-end"
        type="button"
        className="rd-password-toggle"
        aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'}
        onClick={() => setVisible((prev) => !prev)}
      >
        <Icon f7={visible ? 'eye_slash' : 'eye'} size={20} />
      </button>
    </ListInput>
  )
}
