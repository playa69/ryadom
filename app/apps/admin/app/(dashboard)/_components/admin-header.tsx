import { LogOut } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { appPath } from '@/lib/base-path'

export function AdminHeader({ email }: { email: string }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-end gap-4 border-b border-gray-200 bg-white px-6">
      <div className="min-w-0 text-right">
        <div className="truncate text-sm font-medium text-gray-900">{email}</div>
        <div className="text-xs text-gray-500">Администратор</div>
      </div>
      {/* A POST form, not a link: a GET would let a foreign page sign the admin out with an image tag. */}
      <form action={appPath('/logout')} method="post">
        <Button
          type="submit"
          variant="ghost"
          size="icon"
          aria-label="Выйти"
          title="Выйти"
          className="text-gray-500 hover:text-gray-700"
        >
          <LogOut />
        </Button>
      </form>
    </header>
  )
}
