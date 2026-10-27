import type { Logger } from 'pino'
import { getRootLogger } from '@ryadom/core/shared'

export type { Logger }

/**
 * What the logger redacts from entries: passwords, codes from emails, tokens, secrets, the header
 * carrying the access token and, separately, dialog message text and the agent's memory (the text
 * and slots of facts). Conversation content and what is remembered never reach the logs.
 */
export const LOG_REDACT = [
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'code',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'authorization',
  'cookie',
  'text',
  'slots',
  'facts',
  'takeaway',
  'greeting',
  'req.headers.authorization',
  'req.headers.cookie',
]

/**
 * The core's root pino logger at level `LOG_LEVEL`: JSON to stdout, which Docker collects.
 * Russian text belongs only here, in messages for the people who read the logs, and never in
 * responses to the client.
 */
export function createLogger(level: string): Logger {
  return getRootLogger().child({}, { level })
}
