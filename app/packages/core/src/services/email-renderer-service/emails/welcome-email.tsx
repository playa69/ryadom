import { CodeBlock, EmailLayout, Muted, Paragraph } from '../shared/layout'
import { renderEmail } from '../shared/render'
import { NBSP } from '../shared/theme'
import { greeting } from '../shared/format'
import type { RenderedEmail } from '../shared/rendered-email'

interface WelcomeEmailProps {
  userName: string | null
  code: string
  expiresInMinutes: number
}

/** The first email after sign-up: a short greeting and the email confirmation code. */
export function WelcomeEmail({ userName, code, expiresInMinutes }: WelcomeEmailProps) {
  return (
    <EmailLayout preview={`Код для подтверждения почты: ${code}`} heading={greeting(userName)}>
      <Paragraph>{`Рады, что ты рядом. Введи этот код в приложении${NBSP}— и можно начинать.`}</Paragraph>
      <CodeBlock code={code} />
      <Muted>
        {`Код действует ${expiresInMinutes} минут. Если это была не ты и не ты${NBSP}— просто не обращай внимания на письмо.`}
      </Muted>
    </EmailLayout>
  )
}

export function renderWelcomeEmail(props: WelcomeEmailProps): Promise<RenderedEmail> {
  return renderEmail('Добро пожаловать в «Рядом»', <WelcomeEmail {...props} />)
}
