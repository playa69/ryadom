import type { Metadata } from 'next'
import { connection } from 'next/server'
import ProfileScreen from '@/components/ProfileScreen'
import { readWebUrl } from '@/lib/api-url'

export const metadata: Metadata = { title: 'Профиль' }

export default async function ProfilePage() {
  // The landing address is runtime config: read it per request and hand it to the client screen.
  await connection()
  return <ProfileScreen webUrl={readWebUrl()} />
}
