import type { Metadata } from 'next'
import LoginScreen from './login-screen'

export const metadata: Metadata = { title: 'Вход' }

export default function LoginPage() {
  return <LoginScreen />
}
