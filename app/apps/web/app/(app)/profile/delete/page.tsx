import type { Metadata } from 'next'
import ProfileDeleteAccount from '@/components/ProfileDeleteAccount'

export const metadata: Metadata = { title: 'Удаление аккаунта' }

export default function DeleteAccountPage() {
  return <ProfileDeleteAccount />
}
