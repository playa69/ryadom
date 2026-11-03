'use client'

import { usePathname, useRouter } from 'next/navigation'
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { POLICY_VERSION } from '@ryadom/contracts/api/policy'
import { SidebarInset, SidebarProvider } from '@ryadom/ui/components/sidebar'
import { TooltipProvider } from '@ryadom/ui/components/tooltip'
import { deviceTimezone } from '@ryadom/client-core/diary'
import { useAuth, useClient } from '@/lib/auth'
import { WEB_STORAGE_PREFIX } from '@/lib/storage-keys'
import AppSidebar from './AppSidebar'
import BootSplash from './BootSplash'
import OfflineBar from './OfflineBar'
import TermsGate from './TermsGate'

let startingOver = false

/** The site with the terms and the policy: home links them for someone who has not agreed yet. */
const SiteUrl = createContext('')

export function useSiteUrl(): string {
  return useContext(SiteUrl)
}

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
 * Home and «Люди рядом» are open to everyone. Without a session, a device with an anonymous identity
 * signs back in without a screen; anyone else gets the same frame and the same home, as a guest: the
 * first message there makes the account and starts the conversation. Every other page without a
 * session goes to the sign-in.
 *
 * It also holds the door for the terms: until the account has agreed to the current version, the
 * gate stands in place of the page. The answer is cached in the stored user, so an account that has
 * agreed costs no request on later visits.
 */
export default function AppShell({ webUrl, children }: { webUrl: string; children: ReactNode }) {
  const { status, user, updateUser, startAnonymously } = useAuth()
  const client = useClient()
  const router = useRouter()
  const pathname = usePathname()
  const onHome = pathname === '/home'
  /** The pages a guest may see: home, where they start, and the lines of help. */
  const guestPage = onHome || pathname === '/people'
  const userId = user?.id ?? null
  const agreed = user?.consentVersion === POLICY_VERSION
  /** The check could not be made (no network): the app opens, and the server refuses a conversation anyway. */
  const [unchecked, setUnchecked] = useState(false)
  /** The server holds no agreement to the current terms for this account. */
  const [gate, setGate] = useState(false)
  /** Nobody is signed in, and this device has no identity to sign back in with. */
  const [newcomer, setNewcomer] = useState(false)
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
    if (!guestPage || hadSession.current) {
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
  }, [status, onHome, guestPage, client, startAnonymously, router])

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

  if (status === 'authenticated' && gate && !agreed) {
    return <TermsGate termsUrl={`${webUrl}/terms`} privacyUrl={`${webUrl}/privacy`} />
  }
  // The same frame for a guest as for an account: the first message on home makes the account, and the
  // page stays where it is.
  const guest = status === 'anonymous' && newcomer && guestPage
  if (!guest && (status !== 'authenticated' || !(agreed || unchecked))) return <BootSplash />

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
          <SiteUrl.Provider value={webUrl}>{children}</SiteUrl.Provider>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
