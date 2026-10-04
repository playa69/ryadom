import type { EmailTransport, OutgoingEmail } from './types'

/** An email "sent" by the memory transport (EMAIL_TRANSPORT=memory, tests only). */
export interface SentEmail extends OutgoingEmail {
  messageId: string
  sentAt: Date
}

const outbox: SentEmail[] = []

export const memoryTransport: EmailTransport = {
  async send(email) {
    const messageId = `memory-${outbox.length + 1}`
    outbox.push({ ...email, messageId, sentAt: new Date() })
    return { messageId }
  },
}

/** A copy of the memory transport outbox in send order. */
export function getSentEmails(): SentEmail[] {
  return [...outbox]
}

export function clearSentEmails(): void {
  outbox.length = 0
}
