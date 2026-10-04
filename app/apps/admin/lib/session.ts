import 'server-only'

import { isAdminEmail as isAdminEmailInEnv } from '@ryadom/core/config'
import { jwtVerify, SignJWT } from 'jose'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { adminEnv } from '@/lib/env'

/**
 * Admin session.
 *
 * An admin is an address in ADMIN_EMAILS; users have no roles and cannot be granted any. The
 * session is a signed JWT in its own httpOnly cookie for 24 hours, kept out of the database.
 * The allow-list is re-checked on every request, so removing an address and restarting the
 * service revokes access immediately.
 */
export const ADMIN_COOKIE_NAME = 'admin_session'
const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24

export interface AdminSession {
  email: string
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(adminEnv().AUTH_SECRET)
}

export function isAdminEmail(email: string): boolean {
  return isAdminEmailInEnv(adminEnv(), email)
}

export async function createAdminSession(email: string): Promise<string> {
  return new SignJWT({ email: email.trim().toLowerCase() })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_COOKIE_MAX_AGE}s`)
    .sign(getSecret())
}

export function adminSessionCookieOptions(maxAge = ADMIN_COOKIE_MAX_AGE) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge,
    path: '/',
  }
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const token = (await cookies()).get(ADMIN_COOKIE_NAME)?.value
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, getSecret())
    const email = typeof payload.email === 'string' ? payload.email : null
    if (!email || !isAdminEmail(email)) return null
    return { email }
  } catch {
    return null
  }
}

/** Every page and every action in the dashboard starts here. */
export async function requireAdmin(): Promise<AdminSession> {
  const session = await getAdminSession()
  if (!session) redirect('/login')
  return session
}

export async function clearAdminSession(): Promise<void> {
  ;(await cookies()).set(ADMIN_COOKIE_NAME, '', adminSessionCookieOptions(0))
}
