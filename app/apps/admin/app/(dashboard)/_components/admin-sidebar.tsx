'use client'

import { AudioLines, ExternalLink, ScrollText, Users, type LucideIcon } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BrandMark } from '@/components/brand-mark'
import { cn } from '@/lib/utils'

const NAV_ITEMS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: '/users', label: 'Пользователи', icon: Users },
  { href: '/voice', label: 'Голос', icon: AudioLines },
  { href: '/audit', label: 'Журнал действий', icon: ScrollText },
]

const LINK_BASE = 'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors'

export function AdminSidebar({ siteUrl }: { siteUrl: string }) {
  const pathname = usePathname()

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-200 p-4">
        <Link href="/users" className="flex items-center gap-2 rounded-md">
          <div className="flex size-8 items-center justify-center rounded-md bg-gray-900 text-white">
            <BrandMark className="size-5" />
          </div>
          <div>
            <div className="text-sm font-bold text-gray-900">Рядом</div>
            <div className="text-xs text-gray-500">Админ-панель</div>
          </div>
        </Link>
      </div>

      <nav aria-label="Разделы" className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`)
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                LINK_BASE,
                active
                  ? 'bg-gray-100 font-medium text-gray-900'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="space-y-1 border-t border-gray-200 p-3">
        <a
          href={siteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(LINK_BASE, 'text-gray-600 hover:bg-gray-50 hover:text-gray-900')}
        >
          <ExternalLink className="size-4 shrink-0" />
          Перейти на сайт
        </a>
      </div>
    </aside>
  )
}
