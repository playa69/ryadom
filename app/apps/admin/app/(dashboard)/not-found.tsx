import { SearchX } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

/** A missing user or page inside the dashboard keeps the sidebar and header around it. */
export default function DashboardNotFound() {
  return (
    <div className="mx-auto mt-16 max-w-sm rounded-lg border border-gray-200 bg-white p-8 text-center shadow-sm">
      <SearchX className="mx-auto mb-4 size-10 text-gray-400" aria-hidden="true" />
      <h1 className="text-xl font-bold text-gray-900">Страница не найдена</h1>
      <Button asChild className="mt-6 w-full">
        <Link href="/users">К пользователям</Link>
      </Button>
    </div>
  )
}
