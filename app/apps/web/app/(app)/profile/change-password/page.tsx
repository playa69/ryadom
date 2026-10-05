import type { Metadata } from 'next'
import ProfileChangePassword from '@/components/ProfileChangePassword'

export const metadata: Metadata = { title: 'Изменить пароль' }

export default function ChangePasswordPage() {
  return <ProfileChangePassword />
}
