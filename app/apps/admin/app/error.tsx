'use client'

import { AuthCard } from '@/components/auth-card'
import { Button } from '@/components/ui/button'

export default function AdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AuthCard title="Что-то сломалось" description="Попробуйте ещё раз. Если повторяется — посмотрите логи сервиса.">
      {error.digest && <p className="mb-4 text-center font-mono text-xs break-all text-gray-600">digest: {error.digest}</p>}
      <Button className="h-11 w-full text-sm" onClick={reset}>
        Повторить
      </Button>
    </AuthCard>
  )
}
