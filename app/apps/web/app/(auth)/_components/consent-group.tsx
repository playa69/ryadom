'use client'

import { ConsentField } from './fields'
import { ExternalLink } from './parts'

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

/** The name of the first box still empty, for the form to focus after a refused submit. */
export function firstMissingConsent(state: ConsentState): string {
  if (!state.age) return 'consent-age'
  if (!state.disclaimer) return 'consent-disclaimer'
  return 'consent-offer'
}

export function ConsentGroup({
  value,
  onChange,
  termsUrl,
  privacyUrl,
  invalid,
}: {
  value: ConsentState
  onChange(next: ConsentState): void
  termsUrl: string
  privacyUrl: string
  /** A submit was refused for want of agreement: the boxes still empty turn red. */
  invalid?: boolean
}) {
  return (
    <div data-testid="consents" className="flex flex-col gap-2">
      <ConsentField
        name="consent-age"
        checked={value.age}
        invalid={invalid && !value.age}
        onChange={(age) => onChange({ ...value, age })}
      >
        Мне есть 18 лет
      </ConsentField>
      <ConsentField
        name="consent-disclaimer"
        checked={value.disclaimer}
        invalid={invalid && !value.disclaimer}
        onChange={(disclaimer) => onChange({ ...value, disclaimer })}
      >
        Я понимаю, что «Рядом»&nbsp;— сервис самоподдержки, а не психотерапия и не медицинская помощь
      </ConsentField>
      <ConsentField
        name="consent-offer"
        checked={value.offer}
        invalid={invalid && !value.offer}
        onChange={(offer) => onChange({ ...value, offer })}
      >
        Принимаю <ExternalLink href={termsUrl}>условия использования</ExternalLink> и даю согласие на
        обработку персональных данных, с <ExternalLink href={privacyUrl}>политикой</ExternalLink>{' '}
        ознакомлен(а)
      </ConsentField>
    </div>
  )
}
