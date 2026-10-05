import { expect } from '@playwright/test'
import { MAIL_URL } from '../playwright.config'

/**
 * Reading emails from Mailpit. Confirmation codes are never logged and never returned in
 * responses (and must not be), so the only honest way is to read the email like a person.
 */

interface MailpitMessage {
  ID: string
  To: Array<{ Address: string }>
  Subject: string
  Created: string
}

async function listMessages(): Promise<MailpitMessage[]> {
  const response = await fetch(`${MAIL_URL}/api/v1/messages?limit=50`)
  if (!response.ok) throw new Error(`Mailpit ответил ${response.status}`)
  const body = (await response.json()) as { messages?: MailpitMessage[] }
  return body.messages ?? []
}

async function messageText(id: string): Promise<string> {
  const response = await fetch(`${MAIL_URL}/api/v1/message/${id}`)
  if (!response.ok) throw new Error(`Mailpit ответил ${response.status}`)
  const body = (await response.json()) as { Text?: string; HTML?: string }
  return `${body.Text ?? ''}\n${body.HTML ?? ''}`
}

/** Drops emails from earlier tests so that "the last email" means the expected one. */
export async function clearMailbox(): Promise<void> {
  await fetch(`${MAIL_URL}/api/v1/messages`, { method: 'DELETE' })
}

/**
 * The six-digit code from the latest email to this address. The email is sent asynchronously,
 * so we wait for it.
 */
export async function waitForCode(email: string): Promise<string> {
  let code: string | null = null
  await expect
    .poll(
      async () => {
        const messages = await listMessages()
        const mine = messages.find((message) =>
          message.To.some((to) => to.Address.toLowerCase() === email.toLowerCase()),
        )
        if (!mine) return null
        const text = await messageText(mine.ID)
        // The code is the only group of exactly six digits in the email.
        const match = text.match(/\b(\d{6})\b/)
        code = match?.[1] ?? null
        return code
      },
      { message: `не дождались письма с кодом для ${email}`, timeout: 20_000, intervals: [300] },
    )
    .not.toBeNull()
  return code!
}
