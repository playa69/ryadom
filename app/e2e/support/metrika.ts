import type { BrowserContext, Page } from '@playwright/test'

/**
 * A stand-in for the Yandex Metrika tag. The real one is never loaded in a test and nothing leaves the machine
 * (the counter the product runs on is a live one: a test visit would land in the figures). The stack's API names
 * a made-up counter (`E2E_COUNTER_ID`, see scripts/stack.mjs), and every request to a Metrika host that is not
 * the tag is refused and remembered, so a test can say that none was made.
 *
 * What a test checks is what the app asks the tag to do, not what Yandex does with it (that was checked once, against
 * the real tag, in the design of the change `add-yandex-metrika`): every call of the page to `ym(...)` is kept in
 * `window.__ymCalls`, in order, including the ones the page made before the tag arrived.
 */
export const E2E_COUNTER_ID = 999000111

const TAG_STUB = `
(function () {
  var calls = (window.__ymCalls = window.__ymCalls || [])
  var queued = (window.ym && window.ym.a) || []
  window.ym = function () { calls.push(Array.prototype.slice.call(arguments)) }
  window.ym.stub = true
  queued.forEach(function (args) { window.ym.apply(null, args) })
})()
`

const METRIKA_HOSTS = /^https:\/\/mc\.yandex\.(ru|com)\//
const blocked = new WeakMap<BrowserContext, string[]>()

export async function installMetrikaStub(context: BrowserContext): Promise<void> {
  const refused: string[] = []
  blocked.set(context, refused)
  await context.route(METRIKA_HOSTS, (route) => {
    const url = route.request().url()
    if (url === 'https://mc.yandex.ru/metrika/tag.js')
      return route.fulfill({ contentType: 'text/javascript', body: TAG_STUB })
    refused.push(url)
    return route.abort()
  })
}

/** Requests to Metrika hosts, other than the tag itself, that the page tried to make (and were refused). */
export function refusedMetrikaRequests(page: Page): string[] {
  return blocked.get(page.context()) ?? []
}

export type YmCall = [counterId: number, method: string, ...args: unknown[]]

/** Every call the page made to `ym`, in order; only one method if named. Empty until the tag is on the page. */
export async function ymCalls(page: Page, method?: string): Promise<YmCall[]> {
  const calls = await page.evaluate(() => (window as unknown as { __ymCalls?: unknown[][] }).__ymCalls ?? [])
  return (method ? calls.filter((call) => call[1] === method) : calls) as YmCall[]
}

/** The goals reached so far, in order. */
export async function reachedGoals(page: Page): Promise<string[]> {
  return (await ymCalls(page, 'reachGoal')).map((call) => String(call[2]))
}

/** The addresses reported as page views, in order. */
export async function hitUrls(page: Page): Promise<string[]> {
  return (await ymCalls(page, 'hit')).map((call) => String(call[2]))
}
