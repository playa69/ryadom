import { createHash } from 'node:crypto'

export const tokenConfig = {
  /** Entropy of a one-time token, in bytes. */
  bytes: 32,
  /** Codes are typed by hand from an email, so six digits; the attempt limit does the rest. */
  numericCodeDigits: 6,
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
