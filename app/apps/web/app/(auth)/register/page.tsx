import type { Metadata } from 'next'
import RegisterScreen from './register-screen'

export const metadata: Metadata = { title: 'Регистрация' }

export default function RegisterPage() {
  return <RegisterScreen />
}
