import { connection } from 'next/server'
import type { ReactNode } from 'react'
import AppShell from '@/components/AppShell'
import { readWebUrl } from '@/lib/api-url'

export default async function AppLayout({ children }: { children: ReactNode }) {
  // The site address is read per request; without this the value could be frozen at build time.
  await connection()
  return <AppShell webUrl={readWebUrl()}>{children}</AppShell>
}
