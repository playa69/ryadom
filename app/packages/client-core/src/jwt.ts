/**
 * The client has nothing to verify a token's signature with and no reason to; the server does
 * that. The payload is read only to tell whether the token has expired. `exp` is in seconds.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const json = decodeURIComponent(
      atob(base64)
        .split('')
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    )
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

/** `marginMs` treats a token that is about to expire as expired: it must still be valid when the server checks it. */
export function isTokenValid(token: string, marginMs = 0): boolean {
  const data = decodeJwtPayload(token)
  return data !== null && typeof data.exp === 'number' && data.exp * 1000 - marginMs > Date.now()
}

/** Whose token it is (`sub`), to tell "the same person signed in again" from "someone else". */
export function tokenSubject(token: string): string | null {
  const sub = decodeJwtPayload(token)?.sub
  return typeof sub === 'string' && sub ? sub : null
}
