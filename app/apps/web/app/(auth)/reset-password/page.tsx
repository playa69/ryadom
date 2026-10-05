import type { Metadata } from 'next'
import ResetPasswordScreen from './reset-password-screen'

export const metadata: Metadata = { title: 'Смена пароля' }

export default function ResetPasswordPage() {
  return <ResetPasswordScreen />
}
