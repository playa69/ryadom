import { EmailLayout, Paragraph } from '../shared/layout'
import { renderEmail } from '../shared/render'
import { formatMoscowDateTime, greeting } from '../shared/format'
import type { RenderedEmail } from '../shared/rendered-email'

interface PasswordChangedEmailProps {
  userName: string | null
  changedAt: Date
}

/** Password changed. Cannot be turned off: it is the owner's signal that someone else signed in. */
function PasswordChangedEmail({ userName, changedAt }: PasswordChangedEmailProps) {
  return (
    <EmailLayout preview="Пароль от аккаунта изменён" heading={greeting(userName)}>
      <Paragraph>{`Пароль от твоего аккаунта изменён ${formatMoscowDateTime(changedAt)}.`}</Paragraph>
      <Paragraph>
        Если это не ты, сразу восстанови доступ: на странице входа нажми «Забыли пароль?» и задай новый.
      </Paragraph>
    </EmailLayout>
  )
}

export function renderPasswordChangedEmail(props: PasswordChangedEmailProps): Promise<RenderedEmail> {
  return renderEmail('Пароль изменён', <PasswordChangedEmail {...props} />)
}
