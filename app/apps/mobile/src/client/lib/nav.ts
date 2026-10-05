import { f7, f7ready } from 'framework7-react'

/**
 * Navigation between tabs. Each tab has its own View and its own history, so a route opens in the
 * tab it belongs to.
 */

export const TAB_IDS = {
  home: 'view-home',
  journal: 'view-journal',
  profile: 'view-profile',
} as const

const TAB_BY_PREFIX: Array<[string, string]> = [
  ['/home/', TAB_IDS.home],
  ['/journal/', TAB_IDS.journal],
  ['/profile/', TAB_IDS.profile],
]

/** A route from outside, a notification for instance: our screens only, never an external URL. */
export function isAppRoute(route: unknown): route is string {
  return typeof route === 'string' && /^\/(home|journal|profile|dialog)\/([\w-]+\/)*$/.test(route)
}

export function openRoute(route: string): void {
  const entry = TAB_BY_PREFIX.find(([prefix]) => route.startsWith(prefix))
  if (!entry) return
  const tabSelector = `#${entry[1]}`
  f7ready(() => {
    // No tabs means no session, so there is nowhere to navigate.
    if (!document.querySelector(tabSelector)) return
    f7.tab.show(tabSelector)
    // The tab may not have created its router yet (initRouterOnTabShow), so give it a frame.
    setTimeout(() => {
      const view = f7.views.get(tabSelector)
      if (!view) return
      if (route === entry[0]) view.router.navigate(route, { clearPreviousHistory: true })
      else view.router.navigate(route)
    }, 80)
  })
}
