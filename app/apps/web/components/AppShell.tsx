'use client'

import { useRouter } from 'next/navigation'
import { useEffect, type ReactNode } from 'react'
import { SidebarInset, SidebarProvider } from '@ryadom/ui/components/sidebar'
import { TooltipProvider } from '@ryadom/ui/components/tooltip'
import { useAuth } from '@/lib/auth'
import AppSidebar from './AppSidebar'
import BootSplash from './BootSplash'
import OfflineBar from './OfflineBar'

/**
 * Sign-in guard plus the frame of the signed-in app: the sidebar on the left (history, new
 * conversation, account), and to its right the page, which brings its own header (AppHeader) and
 * content. Below 768px the sidebar is a drawer; from there up it is a column that can collapse.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login')
  }, [status, router])

  if (status !== 'authenticated') return <BootSplash />

  return (
    <TooltipProvider delayDuration={200}>
      {/* The rail's right hairline lives inside its width; the extra pixel keeps its 32px tiles centered. */}
      <SidebarProvider className="[--sidebar-width-icon:calc(3.5rem+1px)]">
        <a
          className="fixed top-2 left-2 z-200 -translate-y-[200%] rounded-full bg-brand px-4 py-3 font-semibold text-cta-ink outline-hidden focus-visible:translate-y-0 focus-visible:ring-3 focus-visible:ring-foreground"
          href="#main"
        >
          Перейти к содержимому
        </a>
        <AppSidebar />
        <SidebarInset id="main" tabIndex={-1} className="min-w-0 bg-transparent outline-none">
          <OfflineBar />
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
