import { randomUUID } from 'node:crypto'
import { createLogger } from '../../../shared'
import type { EmailTransport } from './types'

/**
 * Logs the whole email, links included. Only for local development without Mailpit: servers use
 * smtp (Mailpit locally, a relay in the cluster).
 */
export const consoleTransport: EmailTransport = {
  async send(email) {
    const messageId = `console-${randomUUID()}`
    createLogger('email-sender-service').info('Email (console transport)', {
      messageId,
      to: email.to,
      subject: email.subject,
      body: email.text,
    })
    return { messageId }
  },
}
