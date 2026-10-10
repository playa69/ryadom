'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { startAnalytics, trackPageview } from '@ryadom/analytics/browser'

/**
 * Starts product analytics once per page load and reports a page view on every route change.
 *
 * It renders nothing and never waits for the network: the package asks the API what is switched on,
 * queues what is reported meanwhile, and drops it all if analytics are off. A hash or a query change
 * is not a route change, so an in-page anchor does not count as a new page.
 */
export function AnalyticsBoot({ apiBase }: { apiBase: string }) {
  const pathname = usePathname()

  useEffect(() => {
    // Not awaited; a second call (Strict Mode runs effects twice in development) returns the first.
    void startAnalytics({ apiBase, platform: 'landing' })
  }, [apiBase])

  useEffect(() => {
    trackPageview(pathname)
  }, [pathname])

  return null
}
