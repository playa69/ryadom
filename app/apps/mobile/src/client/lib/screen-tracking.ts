import { trackPageview } from '@ryadom/analytics/browser'
import { f7, f7ready } from 'framework7-react'
import type { Router } from 'framework7/types'
import { screenPath } from './analytics'

/**
 * Screen views for the whole app, from one place instead of one call per page.
 *
 * Every View has a router of its own (one per tab), and all of them report to the app: `routeChange`
 * fires on a navigation, on back, and when a tab's router starts. Coming back to a tab whose router
 * already runs changes no route, so `tabShow` covers that. The two can describe the same screen, hence
 * the check against the last one reported.
 */

function reportRoute(route: Partial<Router.Route> | undefined, last: { path: string | null }): void {
  // The matched pattern, not the address: the address of a conversation has its id in it.
  const path = screenPath(route?.route?.path ?? route?.path)
  if (!path || path === last.path) return
  last.path = path
  trackPageview(path)
}

/** Call once; returns the cleanup. */
export function initScreenTracking(): () => void {
  const last = { path: null as string | null }
  let stopped = false
  let cleanup: (() => void) | null = null

  f7ready(() => {
    if (stopped) return
    const onRoute = (route: Router.Route) => reportRoute(route, last)
    const onTab = (tabEl: HTMLElement) => reportRoute(f7.views.get(tabEl)?.router?.currentRoute, last)
    f7.on('routeChange', onRoute)
    f7.on('tabShow', onTab)
    cleanup = () => {
      f7.off('routeChange', onRoute)
      f7.off('tabShow', onTab)
    }
  })

  return () => {
    stopped = true
    cleanup?.()
  }
}
