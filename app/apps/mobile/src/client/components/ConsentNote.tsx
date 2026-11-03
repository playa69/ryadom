import type { MouseEvent } from 'react'
import { openExternal, privacyUrl, termsUrl } from '../lib/links'

const openDoc = (url: () => string) => (event: MouseEvent) => {
  event.preventDefault()
  void openExternal(url())
}

/**
 * What starting means, said next to the action that starts: the first screen, the terms gate and the
 * registration form. There are no boxes to tick — the press is the agreement, as with the services
 * people already use to talk to an AI — so the line names everything the press agrees to: being 18,
 * the terms, the consent to the processing of personal data, and that this is not therapy. The same
 * three agreements as before are recorded for the account.
 */
export default function ConsentNote({
  action,
}: {
  /** The label of the button that agrees; without it, «Поговорить» on the first screen does. */
  action?: string
}) {
  return (
    <p className="rd-fineprint" data-testid="consent-notice">
      «Рядом»&nbsp;— ИИ для самоподдержки, а не психотерапия и не медицинская помощь.{' '}
      {action ? `Нажимая «${action}»` : 'Начиная разговор'}, ты подтверждаешь, что тебе есть 18, принимаешь{' '}
      <a href="#" className="rd-inline-link" onClick={openDoc(termsUrl)}>
        условия использования
      </a>{' '}
      и даёшь{' '}
      <a href="#" className="rd-inline-link" onClick={openDoc(privacyUrl)}>
        согласие на обработку данных
      </a>
      , включая голос и текст разговоров.
    </p>
  )
}
