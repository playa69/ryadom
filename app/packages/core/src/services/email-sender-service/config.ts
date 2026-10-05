import { emailTransportConfig, getEnv, type EmailTransportConfig } from '../../config'
import { consoleTransport } from './transports/console'
import { memoryTransport } from './transports/memory'
import { createSmtpTransport } from './transports/smtp'
import type { EmailTransport } from './transports/types'

export const emailSenderConfig = {
  get from(): string {
    return getEnv().EMAIL_FROM
  },
}

let cached: { key: string; transport: EmailTransport } | undefined

function createTransportFor(config: EmailTransportConfig): EmailTransport {
  switch (config.kind) {
    case 'smtp':
      return createSmtpTransport(config)
    case 'console':
      return consoleTransport
    case 'memory':
      return memoryTransport
  }
}

/** Transport chosen by EMAIL_TRANSPORT; created once per process (SMTP pool). */
export function getEmailTransport(): EmailTransport {
  const config = emailTransportConfig(getEnv())
  const key = JSON.stringify(config)
  if (cached?.key !== key) cached = { key, transport: createTransportFor(config) }
  return cached.transport
}
