import { f7, f7ready } from 'framework7-react'

/**
 * Navigation between tabs. Each tab has its own View and its own history, so a route opens in the
 * tab it belongs to.
 */

export const TAB_IDS = {
  home: 'view-home',
  diary: 'view-diary',
  profile: 'view-profile',
} as const

const TAB_BY_PREFIX: Array<[string, string]> = [
  ['/home/', TAB_IDS.home],
  ['/diary/', TAB_IDS.diary],
  ['/profile/', TAB_IDS.profile],
]

/** A route from outside, a notification for instance: our screens only, never an external URL. */
export function isAppRoute(route: unknown): route is string {
  return typeof route === 'string' && /^\/(home|journal|diary|profile|dialog)\/([\w-]+\/)*$/.test(route)
}

/** The journal tab moved into the diary: an old address (a link, a restored entry) lands there. */
export function currentRoute(requested: string): string {
  return requested.startsWith('/journal/') ? `/diary${requested}` : requested
}

export function openRoute(requested: string): void {
  const route = currentRoute(requested)
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

/** Asks the home screen to start a conversation, as its own «Поговорить» button does. */
export const START_TALK_EVENT = 'ryadom:start-talk'

/** The diary's bridge to a conversation: home comes forward and starts it, voice first. */
export function startTalk(): void {
  f7ready((f7app) => {
    f7app.tab.show(`#${TAB_IDS.home}`)
    // The home screen is mounted already (it is the first tab); the frame lets the tab switch settle.
    setTimeout(() => window.dispatchEvent(new Event(START_TALK_EVENT)), 80)
  })
}
