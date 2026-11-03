import { cn } from '@ryadom/ui/lib/utils'
import { ExternalLink } from './parts'

/**
 * What starting means, said next to the action that starts: the first screen, the terms gate and the
 * registration form. There are no boxes to tick — the press is the agreement, as with the services
 * people already use to talk to an AI — so the line names everything the press agrees to: being 18,
 * the terms, the consent to the processing of personal data, and that this is not therapy. The same
 * three agreements as before are recorded for the account.
 */
export function ConsentNotice({
  action,
  termsUrl,
  privacyUrl,
  className,
}: {
  /** The label of the button that agrees; without it, the first message or the microphone does. */
  action?: string
  termsUrl: string
  privacyUrl: string
  className?: string
}) {
  return (
    <p
      className={cn('text-[0.8125rem] leading-normal text-faint text-balance', className)}
      data-testid="consent-notice"
    >
      «Рядом»&nbsp;— ИИ для самоподдержки, а не психотерапия и не медицинская помощь.{' '}
      {action ? `Нажимая «${action}»` : 'Начиная разговор'}, ты подтверждаешь, что тебе есть 18, принимаешь{' '}
      <ExternalLink href={termsUrl}>условия использования</ExternalLink> и даёшь{' '}
      <ExternalLink href={privacyUrl}>согласие на обработку данных</ExternalLink>, включая голос и текст
      разговоров.
    </p>
  )
}
