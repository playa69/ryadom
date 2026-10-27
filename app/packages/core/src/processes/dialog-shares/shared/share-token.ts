import { createHash, createHmac } from 'node:crypto'
import { getEnv } from '../../../config'

/**
 * The token is not stored: it is the HMAC of the link's id under a server secret, so the owner can be
 * shown the link again while a copy of the table alone gives nobody a working one. A visit finds its
 * row by the SHA-256 of the token. Changing `AUTH_SECRET` retires every link.
 */
export function shareToken(shareId: string): string {
  return createHmac('sha256', getEnv().AUTH_SECRET).update(`dialog-share:v1:${shareId}`).digest('base64url')
}

export function shareTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** `<web client>/s/<token>`: the link always opens the web client, whichever client made it. */
export function shareUrl(token: string): string {
  const env = getEnv()
  const webClient = env.PUBLIC_WEBAPP_URL ?? `${env.PUBLIC_APP_URL}/app`
  return `${webClient}/s/${token}`
}
