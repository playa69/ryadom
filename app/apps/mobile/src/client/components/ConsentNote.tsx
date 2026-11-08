import type { MouseEvent } from 'react'
import { consentUrl, openExternal, termsUrl } from '../lib/links'

const openDoc = (url: () => string) => (event: MouseEvent) => {
  event.preventDefault()
  void openExternal(url())
}

export default function ConsentNote() {
  return (
    <p className="rd-fineprint" data-testid="consent-notice">
      «Рядом»&nbsp;— ИИ для самоподдержки, а не психотерапия и не медицинская помощь.{' '}
      <a href="#" className="rd-inline-link" onClick={openDoc(termsUrl)}>
        Условия использования
      </a>{' '}
      и{' '}
      <a href="#" className="rd-inline-link" onClick={openDoc(consentUrl)}>
        согласие на обработку данных
      </a>
      .
    </p>
  )
}

export function DataConsentCheckbox({
  checked,
  onChange,
}: {
  checked: boolean
  onChange(checked: boolean): void
}) {
  return (
    <label className="rd-incognito rd-unsaved rd-data-consent" data-testid="data-consent">
      <span className="rd-data-consent-text">
        Мне есть 18 лет, я принимаю{' '}
        <a href="#" className="rd-inline-link" onClick={openDoc(termsUrl)}>
          условия использования
        </a>{' '}
        и даю{' '}
        <a href="#" className="rd-inline-link" onClick={openDoc(consentUrl)}>
          согласие на обработку персональных данных
        </a>
        , включая голос и текст разговоров.
      </span>
      <input
        type="checkbox"
        className="rd-unsaved-check"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        required
        data-testid="data-consent-toggle"
      />
    </label>
  )
}
