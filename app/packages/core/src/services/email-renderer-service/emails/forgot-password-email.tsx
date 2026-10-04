import { CodeBlock, EmailLayout, Muted, Paragraph } from '../shared/layout'
import { renderEmail } from '../shared/render'
import { NBSP } from '../shared/theme'
import { greeting } from '../shared/format'
import type { RenderedEmail } from '../shared/rendered-email'

interface ForgotPasswordEmailProps {
  userName: string | null
  code: string
  expiresInMinutes: number
}

/** Code for changing the password. Entered together with the new password in one form. */
export function ForgotPasswordEmail({ userName, code, expiresInMinutes }: ForgotPasswordEmailProps) {
  return (
    <EmailLayout preview={`Код для смены пароля: ${code}`} heading={greeting(userName)}>
      <Paragraph>Введи этот код в приложении и задай новый пароль.</Paragraph>
      <CodeBlock code={code} />
      <Muted>
        {`Код действует ${expiresInMinutes} минут. Если пароль ты не менял(а)${NBSP}— ничего не делай: без кода пароль сменить нельзя.`}
      </Muted>
    </EmailLayout>
  )
}

export function renderForgotPasswordEmail(props: ForgotPasswordEmailProps): Promise<RenderedEmail> {
  return renderEmail('Смена пароля', <ForgotPasswordEmail {...props} />)
}
