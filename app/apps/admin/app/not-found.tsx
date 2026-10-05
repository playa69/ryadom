import Link from 'next/link'
import { AuthCard } from '@/components/auth-card'
import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <AuthCard title="Страница не найдена">
      <Button asChild className="h-11 w-full text-sm">
        <Link href="/users">К пользователям</Link>
      </Button>
    </AuthCard>
  )
}
