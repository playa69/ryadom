import { CodeBlock, EmailLayout, Muted, Paragraph } from '../shared/layout'
import { renderEmail } from '../shared/render'
import { NBSP } from '../shared/theme'
import { greeting } from '../shared/format'
import type { RenderedEmail } from '../shared/rendered-email'

interface EmailConfirmationEmailProps {
  userName: string | null
  code: string
  expiresInMinutes: number
}

/** A repeat email confirmation code: the message sent after sign-up may not have arrived. */
export function EmailConfirmationEmail({ userName, code, expiresInMinutes }: EmailConfirmationEmailProps) {
  return (
    <EmailLayout preview={`Код для подтверждения почты: ${code}`} heading={greeting(userName)}>
      <Paragraph>Вот новый код для подтверждения почты.</Paragraph>
      <CodeBlock code={code} />
      <Muted>{`Код действует ${expiresInMinutes} минут. Прежний код больше не работает.`}</Muted>
    </EmailLayout>
  )
}

export function renderEmailConfirmationEmail(props: EmailConfirmationEmailProps): Promise<RenderedEmail> {
  return renderEmail('Подтверди почту', <EmailConfirmationEmail {...props} />)
}
