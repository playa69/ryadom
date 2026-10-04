import { List, ListItem } from 'framework7-react'
import type { ChangeEvent, MouseEvent } from 'react'
import { openExternal, privacyUrl, termsUrl } from '../lib/links'

/**
 * The agreements of the first screen and of registration: the same three, worded the same, so that
 * what the server records is the same whichever way the person came in. Each is its own box, because
 * being 18, understanding that this is not therapy and consenting to the processing of personal
 * data are three different things to agree to.
 */
export interface ConsentState {
  age: boolean
  disclaimer: boolean
  offer: boolean
}

export const NO_CONSENT: ConsentState = { age: false, disclaimer: false, offer: false }

export const allConsented = (state: ConsentState): boolean => state.age && state.disclaimer && state.offer

const openDoc = (url: () => string) => (event: MouseEvent) => {
  // A link inside the checkbox label: open the document instead of toggling the checkbox.
  event.preventDefault()
  event.stopPropagation()
  void openExternal(url())
}

export default function ConsentList({
  value,
  onChange,
}: {
  value: ConsentState
  onChange: (next: ConsentState) => void
}) {
  const toggle = (key: keyof ConsentState) => (event: ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: event.target.checked })

  return (
    <List className="rd-consents" data-testid="consents">
      <ListItem checkbox name="consent-age" checked={value.age} className="rd-wrap" onChange={toggle('age')}>
        <span slot="title">Мне есть 18 лет</span>
      </ListItem>
      <ListItem
        checkbox
        name="consent-disclaimer"
        checked={value.disclaimer}
        className="rd-wrap"
        onChange={toggle('disclaimer')}
      >
        <span slot="title">
          Я понимаю, что «Рядом»&nbsp;— сервис самоподдержки, а не психотерапия и не медицинская помощь
        </span>
      </ListItem>
      <ListItem
        checkbox
        name="consent-offer"
        checked={value.offer}
        className="rd-wrap"
        onChange={toggle('offer')}
      >
        <span slot="title">
          Принимаю{' '}
          <a href="#" className="rd-inline-link" onClick={openDoc(termsUrl)}>
            условия использования
          </a>{' '}
          и даю согласие на обработку персональных данных, с{' '}
          <a href="#" className="rd-inline-link" onClick={openDoc(privacyUrl)}>
            политикой
          </a>{' '}
          ознакомлен(а)
        </span>
      </ListItem>
    </List>
  )
}
