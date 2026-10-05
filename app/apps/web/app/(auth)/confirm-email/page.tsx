import type { Metadata } from 'next'
import ConfirmEmailScreen from './confirm-email-screen'

export const metadata: Metadata = { title: 'Подтверждение почты' }

export default function ConfirmEmailPage() {
  return <ConfirmEmailScreen />
}
