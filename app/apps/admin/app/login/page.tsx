import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { AuthCard } from '@/components/auth-card'
import { getAdminSession } from '@/lib/session'
import LoginForm from './_components/login-form'

export const metadata: Metadata = { title: 'Вход — админка «Рядом»' }

export default async function LoginPage() {
  if (await getAdminSession()) redirect('/users')
  return (
    <AuthCard title="Админка «Рядом»" description="Вход по одноразовому коду на почту.">
      <LoginForm />
    </AuthCard>
  )
}
