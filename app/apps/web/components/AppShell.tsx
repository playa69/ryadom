'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { SidebarInset, SidebarProvider } from '@ryadom/ui/components/sidebar'
import { TooltipProvider } from '@ryadom/ui/components/tooltip'
import { deviceTimezone } from '@ryadom/client-core/diary'
import { useAuth, useClient } from '@/lib/auth'
import { WEB_STORAGE_PREFIX } from '@/lib/storage-keys'
import AppSidebar from './AppSidebar'
import BootSplash from './BootSplash'
import FirstScreen from './FirstScreen'
import OfflineBar from './OfflineBar'

let startingOver = false

/**
 * Called right before a guest's account is deleted: the session ends, and the person is someone new again,
 * who belongs on the first screen, not on a sign-in for an account they never had.
 */
export function startOver(): void {
  startingOver = true
}

/**
 * Sign-in guard plus the frame of the signed-in app: the sidebar on the left (history, new
 * conversation, account), and to its right the page, which brings its own header (AppHeader) and
 * content. Below 768px the sidebar is a drawer; from there up it is a column that can collapse.
 *
 * Home is open to everyone. Without a session, a device with an anonymous identity signs back in
 * without a screen; anyone else meets home as the first screen, where the first message starts the
 * account and the conversation. Every other page without a session goes to the sign-in.
 *
 * It also holds the door for the terms: until the account has agreed to the current version, the
 * first screen stands in place of the page and takes the person through it. The answer is cached in
 * the stored user, so an account that has agreed costs no request on later visits.
 */
export default function AppShell({ webUrl, children }: { webUrl: string; children: ReactNode }) {
  const { status, user, updateUser, startAnonymously } = useAuth()
  const client = useClient()
  const router = useRouter()
  const pathname = usePathname()
  const onHome = pathname === '/home'
  const userId = user?.id ?? null
  const agreed = user?.consentVersion === POLICY_VERSION
  /** The check could not be made (no network): the app opens, and the server refuses a conversation anyway. */
  const [unchecked, setUnchecked] = useState(false)
  /** The server holds no agreement to the current terms for this account. */
  const [gate, setGate] = useState(false)
  /** Nobody is signed in on home, and this device has no identity to sign back in with. */
  const [newcomer, setNewcomer] = useState(false)
  /** The first screen is starting a conversation: it stays until the conversation opens, not home in between. */
  const [entering, setEntering] = useState(false)
  /** This visit had a session: losing it now is a sign-out, which leads to the sign-in, not to the first screen. */
  const hadSession = useRef(false)

  useEffect(() => {
    if (status === 'authenticated') hadSession.current = true
    if (status !== 'anonymous') return
    if (startingOver) {
      // A guest whose account is gone: the page that deleted it leads home, where they are someone new.
      if (!onHome) return
      startingOver = false
      hadSession.current = false
    }
    // Someone who signs out, or whose session ends, during a visit goes to the sign-in; so does every other
    // page without a session.
    if (!onHome || hadSession.current) {
      router.replace('/login')
      return
    }
    let cancelled = false
    void (async () => {
      if (await client.hasDevice()) {
        try {
          // The agreements were given when the account was made; the gate below asks again if a newer
          // version of the terms is out.
          await startAnonymously()
          return
        } catch {
          // The server does not answer or does not accept the key: the first screen is a fine place to land.
        }
      }
      if (!cancelled) setNewcomer(true)
    })()
    return () => {
      cancelled = true
    }
  }, [status, onHome, client, startAnonymously, router])

  // The conversation the first screen started has opened: from here on the page is the app's.
  useEffect(() => setEntering(false), [pathname])

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
          setGate(true)
        }
      })
      .catch(() => {
        if (!cancelled) setUnchecked(true)
      })
    return () => {
      cancelled = true
    }
  }, [status, userId, agreed, client, updateUser, router])

  // The person's time zone goes to the account when this browser's differs from the one it reported
  // last: the diary day, the reminder and the weekly summary follow it (`REQ-WELL-01`).
  useEffect(() => {
    if (status !== 'authenticated' || !userId) return
    const zone = deviceTimezone()
    if (!zone) return
    const key = `${WEB_STORAGE_PREFIX}timezone.${userId}`
    try {
      if (window.localStorage.getItem(key) === zone) return
    } catch {
      return
    }
    client
      .updateProfile({ timezone: zone })
      .then(() => window.localStorage.setItem(key, zone))
      .catch(() => undefined)
  }, [status, userId, client])

  const firstScreen =
    entering ||
    (status === 'anonymous' && onHome && newcomer) ||
    (status === 'authenticated' && gate && !agreed)
  if (firstScreen) {
    return (
      <FirstScreen termsUrl={`${webUrl}/terms`} privacyUrl={`${webUrl}/privacy`} onStarting={setEntering} />
    )
  }
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
