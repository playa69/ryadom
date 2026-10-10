'use client'

import { usePathname } from 'next/navigation'
import { useEffect, useRef, type ReactNode } from 'react'
import { identify, resetIdentity, startAnalytics, track, trackPageview } from '@ryadom/analytics/browser'
import { AnalyticsEvent, type AccountKind } from '@ryadom/analytics/events'
import { isStandalone } from './analytics'
import { useAuth } from './auth'

/** Set once the page load has reported `app_opened`; a module lives exactly as long as the page does. */
let opened = false

/**
 * Product analytics for the whole app: starts the SDK once per page load, reports a page view for
 * every route, and ties the events to the account while someone is signed in. It renders only its
 * children and is safe to mount anywhere under the auth provider: nothing here waits for analytics,
 * and when the server has them switched off every call is a no-op.
 */
export function AnalyticsProvider({ apiBase, children }: { apiBase: string; children: ReactNode }) {
  const pathname = usePathname()
  const { user } = useAuth()

  // Once per page load. The SDK reads its settings from the API itself, and calls made before it is
  // ready are queued by the package.
  useEffect(() => {
    const standalone = isStandalone(window)
    void startAnalytics({
      apiBase,
      platform: standalone ? 'pwa' : 'web',
      appVersion: process.env.NEXT_PUBLIC_APP_VERSION || undefined,
    })
    if (!opened) {
      opened = true
      track(AnalyticsEvent.AppOpened, { standalone })
    }
  }, [apiBase])

  // The logical route (`/dialog/:id`), not the address: the package strips ids and the query.
  useEffect(() => {
    trackPageview(pathname)
  }, [pathname])

  // The person is the account's id and one trait. Sign-out (or another account taking over) forgets
  // them, so the next events belong to nobody.
  const userId = user?.id ?? null
  const accountKind: AccountKind | null = user ? (user.email === null ? 'anonymous' : 'email') : null
  const identified = useRef<string | null>(null)
  useEffect(() => {
    if (identified.current && identified.current !== userId) resetIdentity()
    if (userId && accountKind) identify(userId, { account_kind: accountKind })
    identified.current = userId
  }, [userId, accountKind])

  return children
}
