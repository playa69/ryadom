import { createTransport } from 'nodemailer'
import type { EmailTransportConfig } from '../../../config'
import type { EmailTransport } from './types'

type SmtpConfig = Extract<EmailTransportConfig, { kind: 'smtp' }>

/** SMTP through nodemailer: Mailpit locally, the provider's SMTP server in prod. */
export function createSmtpTransport(config: SmtpConfig): EmailTransport {
  const transporter = createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
  })
  return {
    async send(email) {
      const info = await transporter.sendMail({
        from: email.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      })
      return { messageId: info.messageId }
    },
  }
}
