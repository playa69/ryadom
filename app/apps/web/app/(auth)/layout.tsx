import { connection } from 'next/server'
import type { ReactNode } from 'react'
import AuthFrame from './auth-frame'
import { readWebUrl } from '@/lib/api-url'

export default async function AuthLayout({ children }: { children: ReactNode }) {
  // The site address is read per request; without this the value could be frozen at build time.
  await connection()
  return <AuthFrame webUrl={readWebUrl()}>{children}</AuthFrame>
}
