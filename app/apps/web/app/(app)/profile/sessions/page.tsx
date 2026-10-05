import type { Metadata } from 'next'
import ProfileSessions from '@/components/ProfileSessions'

export const metadata: Metadata = { title: 'Устройства и сессии' }

export default function SessionsPage() {
  return <ProfileSessions />
}
