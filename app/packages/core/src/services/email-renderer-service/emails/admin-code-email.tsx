import { CodeBlock, EmailLayout, Muted, Paragraph } from '../shared/layout'
import { renderEmail } from '../shared/render'
import { NBSP } from '../shared/theme'
import type { RenderedEmail } from '../shared/rendered-email'

interface AdminCodeEmailProps {
  code: string
  expiresInMinutes: number
}

/**
 * Admin panel sign-in code. There is no greeting by name: an admin is not a user and
 * has no name in the system. The tone is utilitarian: this is a tool's email, not the product's.
 */
function AdminCodeEmail({ code, expiresInMinutes }: AdminCodeEmailProps) {
  return (
    <EmailLayout preview={`Код входа в админку: ${code}`} heading="Код входа в админку">
      <Paragraph>Введи этот код на странице входа.</Paragraph>
      <CodeBlock code={code} />
      <Muted>
        {`Код действует ${expiresInMinutes} минут. Если вход запрашивал не ты${NBSP}— сообщи команде: доступ к админке есть только у нескольких людей.`}
      </Muted>
    </EmailLayout>
  )
}

export function renderAdminCodeEmail(props: AdminCodeEmailProps): Promise<RenderedEmail> {
  return renderEmail('Код входа в админку', <AdminCodeEmail {...props} />)
}
