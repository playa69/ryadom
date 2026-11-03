import type { MetrikaConfigApiResponse } from '@ryadom/contracts/api/analytics'
import { MetrikaGoal, type AnalyticsPlatform } from './events'
import { sanitizeUrl } from './sanitize'

/**
 * Yandex Metrika: one counter for the landing, the web app, the PWA, Telegram and the store builds.
 *
 * Same rules as the PostHog side (`browser.ts`), and where Metrika cannot follow them, the difference is
 * written down here and in the spec (`product-analytics`, "Яндекс Метрика: что передаётся"):
 *
 * 1. **Nothing happens until the server says so.** `startMetrika` gets the counter number from
 *    `GET /api/analytics/config`; without one the tag is never downloaded. Calls made before that are queued
 *    and dropped if Metrika turns out to be off.
 * 2. **Addresses are ours.** The tag is started with `defer: true`, which makes it send no page view of its
 *    own (checked against the real tag: only a `nohit=1` handshake goes out, and a `pushState` sends nothing),
 *    and every page view is a `hit` with the address from `sanitizeUrl`: no fragment (Telegram's launch data
 *    lives there), no query but campaign labels (the password-reset code), ids as `:id`.
 * 3. **Recording only where it is safe.** Session recording (Webvisor) and the click map run on the landing
 *    alone, and only if the environment allows. In the apps they are off whatever the server says: those are
 *    the screens with conversations, e-mail and SOS.
 * 4. **The person can opt out**, and a browser's Do Not Track is honoured: nothing is loaded; an opt-out
 *    during the session stops the counter (`destruct`, which also stops recording and the click map).
 *
 * What is different from PostHog and cannot be helped: Metrika sets its own cookie, and the visitor's IP
 * address reaches Yandex straight from the browser, not through our proxy.
 *
 * Nothing here throws: a failure of analytics must never become a failure of the app.
 */

type Ym = ((counterId: number, method: string, ...args: unknown[]) => void) & { a?: unknown[]; l?: number }
type Status = 'idle' | 'ready' | 'paused' | 'disabled'

export interface StartMetrikaOptions {
  /** What the server said: absent means Metrika is off. */
  config: MetrikaConfigApiResponse | undefined
  platform: AnalyticsPlatform
  appVersion?: string | undefined
  /** The person's opt-out or the browser's Do Not Track: nothing is loaded. */
  suppressed: boolean
  /** For tests: how the tag is put on the page. */
  loadTag?: () => void
}

const TAG_URL = 'https://mc.yandex.ru/metrika/tag.js'
const MAX_QUEUE = 50
/** The main goal fires once per device: this marks that it did. */
const MAIN_GOAL_KEY = 'ryadom.metrika.main-goal'
/** The reply that makes a dialog "a dialog with replies": the third one the server accepted. */
export const MAIN_GOAL_REPLIES = 3

let status: Status = 'idle'
let launch: StartMetrikaOptions | null = null
let counterId = 0
let visitParams: Record<string, string> = {}
let previousUrl: string | null = null
const queue: Array<(ym: Ym) => void> = []

function safely(action: () => void): void {
  try {
    action()
  } catch {
    // Analytics must not break the screen it is measuring.
  }
}

function currentYm(): Ym | undefined {
  return (globalThis as unknown as { ym?: Ym }).ym
}

/** The standard loader of the counter: a stub that queues calls until the tag arrives, and the script itself. */
function defaultLoadTag(): void {
  const scope = globalThis as unknown as { ym?: Ym }
  scope.ym =
    scope.ym ??
    (function ym(...args: unknown[]) {
      const stub = scope.ym as Ym
      ;(stub.a = stub.a ?? []).push(args)
    } as Ym)
  scope.ym.l = Date.now()
  if (Array.from(document.scripts).some((script) => script.src === TAG_URL)) return
  const script = document.createElement('script')
  script.async = true
  script.src = TAG_URL
  document.head.appendChild(script)
}

function load(): void {
  const options = launch
  if (!options?.config) return
  counterId = options.config.counterId
  // Recording and the click map: the landing only, and only if the environment allows (see the header).
  const onLanding = options.platform === 'landing'
  safely(() => {
    ;(options.loadTag ?? defaultLoadTag)()
    currentYm()?.(counterId, 'init', {
      // No page view of its own: they are sent by `metrikaHit` with a clean address.
      defer: true,
      clickmap: onLanding && options.config?.clickmap === true,
      webvisor: onLanding && options.config?.webvisor === true,
      // Outbound-link tracking and the "accurate bounce" timer send their own hits with the real address.
      trackLinks: false,
      accurateTrackBounce: false,
    })
  })
  visitParams = {
    app_platform: options.platform,
    ...(options.appVersion ? { app_version: options.appVersion } : {}),
  }
  status = 'ready'
  for (const action of queue.splice(0)) {
    const ym = currentYm()
    if (ym) safely(() => action(ym))
  }
}

/**
 * Starts Metrika once per page load (later calls are ignored). Call it with the answer of the config request,
 * whether or not Metrika is on: a missing `config` is how the queue gets dropped.
 */
export function startMetrika(options: StartMetrikaOptions): void {
  if (status !== 'idle') return
  if (!options.config) {
    turnOff()
    return
  }
  launch = options
  if (options.suppressed) {
    status = 'paused'
    queue.length = 0
    return
  }
  load()
}

function turnOff(): void {
  status = 'disabled'
  queue.length = 0
}

function whenReady(action: (ym: Ym) => void): void {
  if (status === 'disabled' || status === 'paused') return
  if (status === 'ready') {
    const ym = currentYm()
    if (ym) safely(() => action(ym))
    return
  }
  if (queue.length < MAX_QUEUE) queue.push(action)
}

/** Whether a call made now would be reported (now or once the config arrives): false when Metrika is off. */
export function metrikaWillReport(): boolean {
  return status === 'idle' || status === 'ready'
}

/**
 * The person turned analytics off (or back on) on this device. Off: the counter is stopped for the rest of
 * the page's life, recording included. On again: it is started anew.
 */
export function setMetrikaSuppressed(suppressed: boolean): void {
  if (suppressed && status === 'ready') {
    safely(() => currentYm()?.(counterId, 'destruct'))
    status = 'paused'
    previousUrl = null
    return
  }
  if (!suppressed && status === 'paused' && launch) load()
}

/** A page was shown. `url` has to come from `sanitizeUrl` or be built from its parts: this reports it as is. */
export function metrikaHit(url: string): void {
  whenReady((ym) => {
    const referer = previousUrl ?? externalReferrer()
    previousUrl = url
    ym(counterId, 'hit', url, {
      // The path is the page's name: the real title could say more than the route does.
      title: pathOf(url),
      ...(referer ? { referer } : {}),
      params: visitParams,
    })
  })
}

/** Reports a goal of the catalog. */
export function metrikaGoal(goal: MetrikaGoal): void {
  whenReady((ym) => ym(counterId, 'reachGoal', goal))
}

/** What the person came from: the address of the previous site, cleaned like ours. Empty when there is none. */
function externalReferrer(): string {
  const referrer = globalThis.document?.referrer
  return referrer ? sanitizeUrl(referrer) : ''
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/**
 * The server accepted a reply of the person. `count` is how many accepted replies the dialog has now, `delta` how
 * many it gained: a jump of more than one is the record being loaded after a reconnect, not a person speaking, and
 * counts for nothing. The first reply is a goal each time a dialog gets one; the main goal is the third reply, once
 * per device (the mark is only set when the goal can be reported, so a person who opted out is not "used up").
 */
export function reportDialogReplies(count: number, delta: number): void {
  if (delta !== 1) return
  if (count === 1) metrikaGoal(MetrikaGoal.FirstReply)
  if (count === MAIN_GOAL_REPLIES && metrikaWillReport() && !mainGoalReached()) {
    markMainGoalReached()
    metrikaGoal(MetrikaGoal.FirstDialog3Replies)
  }
}

function mainGoalReached(): boolean {
  try {
    return globalThis.localStorage?.getItem(MAIN_GOAL_KEY) === '1'
  } catch {
    return false
  }
}

function markMainGoalReached(): void {
  try {
    globalThis.localStorage?.setItem(MAIN_GOAL_KEY, '1')
  } catch {
    // Storage may be blocked: the goal can then repeat in another dialog, which is the lesser harm.
  }
}

/** For tests: back to a fresh page load. */
export function resetMetrikaForTests(): void {
  status = 'idle'
  launch = null
  counterId = 0
  visitParams = {}
  previousUrl = null
  queue.length = 0
}
