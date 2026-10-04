'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { SidebarInset, SidebarProvider } from '@ryadom/ui/components/sidebar'
import { TooltipProvider } from '@ryadom/ui/components/tooltip'
import { useAuth, useClient } from '@/lib/auth'
import AppSidebar from './AppSidebar'
import BootSplash from './BootSplash'
import OfflineBar from './OfflineBar'

/**
 * Sign-in guard plus the frame of the signed-in app: the sidebar on the left (history, new
 * conversation, account), and to its right the page, which brings its own header (AppHeader) and
 * content. Below 768px the sidebar is a drawer; from there up it is a column that can collapse.
 *
 * It also holds the door for the terms: until the account has agreed to the current version, the
 * app does not open, and the first screen takes the person through it. The answer is cached in the
 * stored user, so an account that has agreed costs no request on later visits.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const { status, user, updateUser } = useAuth()
  const client = useClient()
  const router = useRouter()
  const userId = user?.id ?? null
  const agreed = user?.consentVersion === POLICY_VERSION
  /** The check could not be made (no network): the app opens, and the server refuses a conversation anyway. */
  const [unchecked, setUnchecked] = useState(false)

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login')
  }, [status, router])

  useEffect(() => {
    if (status !== 'authenticated' || !userId || agreed) return
    let cancelled = false
    // A new question: an answer of "could not check" from before does not stand for it.
    setUnchecked(false)
    client
      .getCurrentUser()
      .then((me) => {
        if (cancelled) return
        if (me.consentsCompleted && me.consentVersion === POLICY_VERSION) {
          updateUser({ consentVersion: me.consentVersion })
        } else {
          router.replace('/welcome')
        }
      })
      .catch(() => {
        if (!cancelled) setUnchecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [status, userId, agreed, client, updateUser, router])

  if (status !== 'authenticated' || !(agreed || unchecked)) return <BootSplash />

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
